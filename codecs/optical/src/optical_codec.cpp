/*
 * Copyright (c) 2026 Evan Crawley (Bash Alarmist)
 *
 * Pastebin Worker's optical QR decoder wrapper around zxing-cpp.
 *
 * Every accepted camera frame follows one QR-only reader path. The wrapper
 * bypasses MultiFormatReader and its per-frame reader allocations, and it
 * disables rotate/invert/downscale sweeps because both ends are controlled.
 * Packed RGBA/BGRX inputs use their green channel as luminance and are
 * thresholded directly into the binary matrix; camera Y planes enter through
 * readFullLum.
 */

#include "BinaryBitmap.h"
#include "BitMatrix.h"
#include "DecoderResult.h"
#include "GlobalHistogramBinarizer.h"
#include "ImageView.h"
#include "ReaderOptions.h"
#include "qrcode/QRDecoder.h"
#include "qrcode/QRReader.h"

#include <emscripten/bind.h>
#include <emscripten/heap.h>
#include <emscripten/val.h>

#include <cstdint>
#include <limits>
#include <utility>
#include <vector>

using namespace ZXing;

enum class InputLayout
{
	Lum,
	PackedColor,
	PackedMono1,
};

static constexpr int MAX_SYMBOLS = 9;

static bool validInput(int bufferPtr, int width, int height, int maxSymbols, InputLayout layout)
{
	if (bufferPtr <= 0 || width <= 0 || height <= 0 || width > 0xffff || height > 0xffff ||
		maxSymbols <= 0 || maxSymbols > MAX_SYMBOLS)
		return false;

	const auto w = static_cast<size_t>(width);
	const auto h = static_cast<size_t>(height);
	if (w > static_cast<size_t>(std::numeric_limits<int>::max()) / h)
		return false;

	size_t rowBytes;
	switch (layout) {
	case InputLayout::Lum: rowBytes = w; break;
	case InputLayout::PackedColor: rowBytes = w * 4; break;
	case InputLayout::PackedMono1: rowBytes = (w + 7) / 8; break;
	}
	if (rowBytes > std::numeric_limits<size_t>::max() / h)
		return false;

	const auto ptr = static_cast<size_t>(bufferPtr);
	const auto bytes = rowBytes * h;
	const auto heapSize = emscripten_get_heap_size();
	return ptr <= heapSize && bytes <= heapSize - ptr;
}

static emscripten::val toUint8Array(const std::vector<uint8_t>& bytes)
{
	thread_local const emscripten::val Uint8Array = emscripten::val::global("Uint8Array");
	// Uint8Array.new_ copies out of the wasm heap synchronously, so the view
	// over a local ByteArray is safe.
	return Uint8Array.new_(emscripten::typed_memory_view(bytes.size(), bytes.data()));
}

static emscripten::val readBitmap(const BinaryBitmap& bitmap, int maxSymbols)
{
	static const auto options =
		ReaderOptions().formats(BarcodeFormat::QRCode).tryHarder(true).returnErrors(false);
	auto payloads = QRCode::ReadStandardPayloads(bitmap, maxSymbols, options);

	auto results = emscripten::val::array();
	for (size_t i = 0; i < payloads.size(); ++i)
		results.set(i, toUint8Array(payloads[i]));
	return results;
}

static emscripten::val readFullImpl(int bufferPtr, int width, int height, ImageFormat format, int maxSymbols)
{
	try {
		const auto layout = format == ImageFormat::Lum ? InputLayout::Lum : InputLayout::PackedColor;
		if (!validInput(bufferPtr, width, height, maxSymbols, layout))
			return emscripten::val::array();
		ImageView iv(reinterpret_cast<uint8_t*>(static_cast<uintptr_t>(bufferPtr)), width, height, format);
		GlobalHistogramBinarizer bitmap(iv);
		return readBitmap(bitmap, maxSymbols);
	} catch (...) {
		return emscripten::val::array();
	}
}

emscripten::val readFull(int bufferPtr, int width, int height, int maxSymbols)
{
	return readFullImpl(bufferPtr, width, height, ImageFormat::RGBA, maxSymbols);
}

/** Single-channel counterpart for camera NV12/I420 Y planes. */
emscripten::val readFullLum(int bufferPtr, int width, int height, int maxSymbols)
{
	return readFullImpl(bufferPtr, width, height, ImageFormat::Lum, maxSymbols);
}

/** Decode the sender's exact APNG grid without rediscovering geometry that the
 * carrier metadata already describes. The packed frame has already been
 * downsampled to one pixel per displayed module; each cell contains the fixed
 * four-module quiet zone followed by one QR module matrix. */
emscripten::val readModuleGridMono1(int bufferPtr, int width, int height,
								   int qrVersion, int columns, int rows)
{
	try {
		constexpr int margin = 4;
		if (qrVersion < 1 || qrVersion > 40 || columns < 1 || rows < 1 ||
			columns > MAX_SYMBOLS / rows)
			return emscripten::val::array();
		const int symbolCount = columns * rows;
		const int modules = 17 + 4 * qrVersion;
		const int cellSize = modules + 2 * margin;
		if (width != cellSize * columns || height != cellSize * rows ||
			!validInput(bufferPtr, width, height, symbolCount, InputLayout::PackedMono1))
			return emscripten::val::array();

		const auto* packed = reinterpret_cast<const uint8_t*>(static_cast<uintptr_t>(bufferPtr));
		const int stride = (width + 7) / 8;
		BitMatrix matrix(modules);
		auto results = emscripten::val::array();
		int resultIndex = 0;
		for (int cellY = 0; cellY < rows; ++cellY) {
			for (int cellX = 0; cellX < columns; ++cellX) {
				const int originX = cellX * cellSize + margin;
				const int originY = cellY * cellSize + margin;
				for (int y = 0; y < modules; ++y) {
					auto* dst = matrix.row(y).begin();
					const auto* src = packed + size_t(originY + y) * stride;
					for (int x = 0; x < modules; ++x) {
						const int sourceX = originX + x;
						const bool white = (src[sourceX >> 3] & (0x80 >> (sourceX & 7))) != 0;
						dst[x] = white ? BitMatrix::UNSET_V : BitMatrix::SET_V;
					}
				}
				try {
					auto decoded = QRCode::Decode(matrix);
					if (!decoded.isValid())
						continue;
					auto content = std::move(decoded).content();
					results.set(resultIndex++, toUint8Array(content.bytes));
				} catch (...) {
					// One damaged cell must not discard valid peers in the same grid.
				}
			}
		}
		return results;
	} catch (...) {
		return emscripten::val::array();
	}
}

/** Packed BGRX camera frames use the same byte layout as zxing-cpp's BGRA. */
emscripten::val readFullBGRX(int bufferPtr, int width, int height, int maxSymbols)
{
	return readFullImpl(bufferPtr, width, height, ImageFormat::BGRA, maxSymbols);
}

EMSCRIPTEN_BINDINGS(OpticalCodec)
{
	using namespace emscripten;

	function("readFull", &readFull);
	function("readFullLum", &readFullLum);
	function("readModuleGridMono1", &readModuleGridMono1);
	function("readFullBGRX", &readFullBGRX);
};
