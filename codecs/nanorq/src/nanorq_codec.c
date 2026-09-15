#include <emscripten/emscripten.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "nanorq_core.h"
#include "nanorq_ops.h"
#include "qrcodegen.h"
#include "rqtables.h"

#define PAYLOAD_ID_BYTES 4u
#define MAX_ENCODING_SYMBOL_ID 0x00ffffffu

typedef struct {
  nanorq_core core;
  uint32_t source_symbols;
  uint32_t symbol_size;
  uint32_t stride;
  uint8_t *prepare;
  uint8_t *work;
  uint8_t *matrix;
  uint8_t *scratch;
  schedule operations;
  size_t work_size;
  size_t schedule_size;
  bool prepared;
} nanorq_encoder;

typedef struct {
  nanorq_core initial_core;
  uint32_t transfer_length;
  uint32_t source_symbols;
  uint32_t symbol_size;
  uint32_t stride;
  uint32_t received;
  uint32_t capacity;
  uint32_t seen_capacity;
  uint32_t packet_stride;
  uint32_t *seen;
  uint32_t *encoding_symbol_ids;
  uint8_t *initial_prepare;
  uint8_t *initial_matrix;
  uint8_t *overhead_payloads;
  uint8_t *input_packet;
  bool input_ready;
  bool complete;
} nanorq_decoder;

typedef struct {
  uint8_t data_and_temp[qrcodegen_BUFFER_LEN_MAX];
  uint8_t encoded[qrcodegen_BUFFER_LEN_MAX];
  struct qrcodegen_FixedMaskCache cache;
} nanorq_qr;

static bool checked_size_multiply(size_t left, size_t right, size_t *result) {
  if (left != 0 && right > SIZE_MAX / left)
    return false;
  *result = left * right;
  return true;
}

static bool codec_memory_requirements(
    uint32_t source_symbols, uint32_t overhead, uint32_t stride,
    struct nanorq_core_mem_reqs *requirements) {
  nanorq_core_get_memory_reqs(source_symbols, overhead, stride, requirements);
  return requirements->prepare_bytes != 0 && requirements->work_bytes != 0 &&
         requirements->matrix_bytes != 0 &&
         requirements->schedule_bytes != 0;
}

static uint8_t *allocate_matrix(nanorq_core *core, uint32_t stride) {
  return obl_alloc(nanorq_core_get_pc_rows(core), stride,
                   nanorq_oblas.align_size);
}

static uint32_t source_symbol_count(uint32_t transfer_length,
                                    uint32_t symbol_size) {
  if (transfer_length == 0 || symbol_size == 0 || symbol_size % 8 != 0 ||
      symbol_size > UINT32_MAX - PAYLOAD_ID_BYTES)
    return 0;
  uint32_t symbols = transfer_length / symbol_size +
                     (transfer_length % symbol_size != 0);
  return symbols <= K_max ? symbols : 0;
}

static void encoder_release(nanorq_encoder *encoder) {
  if (!encoder)
    return;
  free(encoder->prepare);
  free(encoder->work);
  obl_free(encoder->matrix);
  free(encoder->scratch);
  free(encoder->operations.ops.a);
  free(encoder);
}

static void decoder_release(nanorq_decoder *decoder) {
  if (!decoder)
    return;
  free(decoder->seen);
  free(decoder->encoding_symbol_ids);
  free(decoder->initial_prepare);
  obl_free(decoder->initial_matrix);
  free(decoder->overhead_payloads);
  free(decoder->input_packet);
  free(decoder);
}

EMSCRIPTEN_KEEPALIVE void *nanorq_alloc(size_t length) {
  return malloc(length);
}

EMSCRIPTEN_KEEPALIVE void nanorq_free(void *pointer) {
  free(pointer);
}

EMSCRIPTEN_KEEPALIVE nanorq_encoder *
nanorq_encoder_new(uint32_t transfer_length, uint32_t symbol_size) {
  uint32_t symbols = source_symbol_count(transfer_length, symbol_size);
  if (symbols == 0)
    return NULL;

  nanorq_encoder *encoder = calloc(1, sizeof(*encoder));
  if (!encoder || !nanorq_core_encoder_new(symbols, 0, &encoder->core)) {
    encoder_release(encoder);
    return NULL;
  }

  encoder->source_symbols = symbols;
  encoder->symbol_size = symbol_size;
  encoder->stride = nanorq_core_recommended_stride(symbol_size);
  struct nanorq_core_mem_reqs requirements;
  if (!codec_memory_requirements(symbols, 0, encoder->stride,
                                 &requirements)) {
    encoder_release(encoder);
    return NULL;
  }
  encoder->work_size = requirements.work_bytes;
  encoder->schedule_size = requirements.schedule_bytes;
  encoder->prepare = malloc(requirements.prepare_bytes);
  encoder->work = malloc(encoder->work_size);
  encoder->matrix = allocate_matrix(&encoder->core, encoder->stride);
  if (encoder->stride != encoder->symbol_size)
    encoder->scratch = malloc(encoder->stride);
  void *schedule_memory = malloc(encoder->schedule_size);
  encoder->operations.ops.a = schedule_memory;
  if (!encoder->prepare || !encoder->work || !encoder->matrix ||
      (encoder->stride != encoder->symbol_size && !encoder->scratch) ||
      !schedule_memory ||
      !nanorq_core_prepare(&encoder->core, encoder->prepare,
                           requirements.prepare_bytes)) {
    encoder_release(encoder);
    return NULL;
  }

  return encoder;
}

/* Source rows are part of the encoder matrix. Exposing that storage lets the
 * JS wrapper populate it directly instead of growing WebAssembly.Memory with
 * a second, full-transfer staging allocation. */
EMSCRIPTEN_KEEPALIVE uint8_t *
nanorq_encoder_source(nanorq_encoder *encoder) {
  if (!encoder || encoder->prepared)
    return NULL;
  return nanorq_core_get_symbol_ptr(&encoder->core, encoder->matrix,
                                    encoder->stride, 0);
}

EMSCRIPTEN_KEEPALIVE uint32_t
nanorq_encoder_source_stride(const nanorq_encoder *encoder) {
  return encoder ? encoder->stride : 0;
}

EMSCRIPTEN_KEEPALIVE int nanorq_encoder_prepare(nanorq_encoder *encoder) {
  if (!encoder)
    return 0;
  if (encoder->prepared)
    return 1;
  void *schedule_memory = encoder->operations.ops.a;
  if (!schedule_init(&encoder->operations, schedule_memory,
                     encoder->schedule_size))
    return 0;
  nanorq_core_set_op_callback(&encoder->core, &encoder->operations, ops_push);
  if (!nanorq_core_precalculate(&encoder->core, encoder->work,
                                encoder->work_size) ||
      encoder->operations.overflowed || encoder->operations.cpidx != 2)
    return 0;
  ops_run(&encoder->core, encoder->matrix, encoder->stride,
          &encoder->operations);
  encoder->prepared = true;
  return 1;
}

EMSCRIPTEN_KEEPALIVE uint32_t
nanorq_encoder_source_symbols(const nanorq_encoder *encoder) {
  return encoder ? encoder->source_symbols : 0;
}

EMSCRIPTEN_KEEPALIVE uint32_t
nanorq_encoder_packet_length(const nanorq_encoder *encoder) {
  return encoder ? encoder->symbol_size + PAYLOAD_ID_BYTES : 0;
}

EMSCRIPTEN_KEEPALIVE int
nanorq_encoder_repair(nanorq_encoder *encoder, uint32_t sequence,
                      uint8_t *packet, uint32_t packet_length) {
  if (!encoder || !encoder->prepared || !packet ||
      packet_length != encoder->symbol_size + PAYLOAD_ID_BYTES)
    return 0;

  uint32_t repair_range =
      MAX_ENCODING_SYMBOL_ID + 1u - encoder->source_symbols;
  uint32_t encoding_symbol_id =
      encoder->source_symbols + (sequence % repair_range);
  packet[0] = 0;
  packet[1] = (uint8_t)(encoding_symbol_id >> 16);
  packet[2] = (uint8_t)(encoding_symbol_id >> 8);
  packet[3] = (uint8_t)encoding_symbol_id;
  uint8_t *payload = encoder->stride == encoder->symbol_size
                         ? packet + PAYLOAD_ID_BYTES
                         : encoder->scratch;
  ops_mix(&encoder->core, encoder->matrix, encoder->stride,
          encoding_symbol_id, payload);
  if (payload == encoder->scratch)
    memcpy(packet + PAYLOAD_ID_BYTES, payload, encoder->symbol_size);
  return 1;
}

EMSCRIPTEN_KEEPALIVE void nanorq_encoder_free(nanorq_encoder *encoder) {
  encoder_release(encoder);
}

EMSCRIPTEN_KEEPALIVE nanorq_decoder *
nanorq_decoder_new(uint32_t transfer_length, uint32_t symbol_size) {
  uint32_t symbols = source_symbol_count(transfer_length, symbol_size);
  if (symbols == 0)
    return NULL;

  nanorq_decoder *decoder = calloc(1, sizeof(*decoder));
  if (!decoder)
    return NULL;
  decoder->transfer_length = transfer_length;
  decoder->source_symbols = symbols;
  decoder->symbol_size = symbol_size;
  decoder->packet_stride = symbol_size + PAYLOAD_ID_BYTES;
  if (!nanorq_core_encoder_new(symbols, 0, &decoder->initial_core)) {
    decoder_release(decoder);
    return NULL;
  }
  decoder->stride = nanorq_core_recommended_stride(symbol_size);
  struct nanorq_core_mem_reqs requirements;
  if (!codec_memory_requirements(symbols, 0, decoder->stride,
                                 &requirements)) {
    decoder_release(decoder);
    return NULL;
  }
  decoder->initial_prepare = malloc(requirements.prepare_bytes);
  decoder->initial_matrix =
      allocate_matrix(&decoder->initial_core, decoder->stride);
  decoder->capacity = symbols + 8;
  decoder->seen_capacity = 1;
  while (decoder->seen_capacity < decoder->capacity * 2)
    decoder->seen_capacity <<= 1;
  decoder->seen =
      malloc((size_t)decoder->seen_capacity * sizeof(uint32_t));
  decoder->encoding_symbol_ids =
      malloc((size_t)decoder->capacity * sizeof(uint32_t));
  size_t overhead_bytes;
  if (!checked_size_multiply(decoder->capacity - symbols, symbol_size,
                             &overhead_bytes)) {
    decoder_release(decoder);
    return NULL;
  }
  decoder->overhead_payloads = malloc(overhead_bytes);
  decoder->input_packet = malloc(decoder->packet_stride);
  if (!decoder->initial_prepare || !decoder->initial_matrix ||
      !decoder->seen || !decoder->encoding_symbol_ids ||
      !decoder->overhead_payloads || !decoder->input_packet ||
      !nanorq_core_prepare(&decoder->initial_core,
                           decoder->initial_prepare,
                           requirements.prepare_bytes)) {
    decoder_release(decoder);
    return NULL;
  }
  memset(decoder->seen, 0xff,
         (size_t)decoder->seen_capacity * sizeof(uint32_t));
  return decoder;
}

static int decoder_grow(nanorq_decoder *decoder) {
  if (decoder->received < decoder->capacity)
    return 1;
  uint32_t overhead_capacity =
      decoder->capacity - decoder->source_symbols;
  if (overhead_capacity >
      (UINT32_MAX - decoder->source_symbols) / 2)
    return 0;
  uint32_t next_capacity =
      decoder->source_symbols + overhead_capacity * 2;
  size_t id_bytes;
  size_t payload_bytes;
  if (!checked_size_multiply(next_capacity, sizeof(uint32_t), &id_bytes) ||
      !checked_size_multiply(next_capacity - decoder->source_symbols,
                             decoder->symbol_size, &payload_bytes))
    return 0;
  uint32_t *next_ids =
      realloc(decoder->encoding_symbol_ids, id_bytes);
  if (!next_ids)
    return 0;
  decoder->encoding_symbol_ids = next_ids;
  uint8_t *next_payloads =
      realloc(decoder->overhead_payloads, payload_bytes);
  if (!next_payloads)
    return 0;
  decoder->overhead_payloads = next_payloads;
  decoder->capacity = next_capacity;
  return 1;
}

static uint32_t packet_encoding_symbol_id(const uint8_t *packet) {
  return ((uint32_t)packet[1] << 16) | ((uint32_t)packet[2] << 8) |
         packet[3];
}

static uint32_t decoder_seen_slot(const nanorq_decoder *decoder,
                                  uint32_t encoding_symbol_id) {
  uint32_t slot =
      (encoding_symbol_id * 2654435761u) & (decoder->seen_capacity - 1);
  while (decoder->seen[slot] != UINT32_MAX &&
         decoder->seen[slot] != encoding_symbol_id)
    slot = (slot + 1) & (decoder->seen_capacity - 1);
  return slot;
}

static int decoder_seen_insert(nanorq_decoder *decoder,
                               uint32_t encoding_symbol_id) {
  uint32_t slot = decoder_seen_slot(decoder, encoding_symbol_id);
  if (decoder->seen[slot] == encoding_symbol_id)
    return 0;

  if ((decoder->received + 1) * 2 >= decoder->seen_capacity) {
    uint32_t previous_capacity = decoder->seen_capacity;
    uint32_t *previous = decoder->seen;
    if (previous_capacity > UINT32_MAX / 2)
      return -1;
    uint32_t next_capacity = previous_capacity << 1;
    size_t next_bytes;
    if (!checked_size_multiply(next_capacity, sizeof(uint32_t),
                               &next_bytes))
      return -1;
    uint32_t *next = malloc(next_bytes);
    if (!next)
      return -1;
    decoder->seen = next;
    decoder->seen_capacity = next_capacity;
    memset(decoder->seen, 0xff,
           (size_t)decoder->seen_capacity * sizeof(uint32_t));
    for (uint32_t index = 0; index < previous_capacity; index++) {
      if (previous[index] != UINT32_MAX)
        decoder->seen[decoder_seen_slot(decoder, previous[index])] =
            previous[index];
    }
    free(previous);
    slot = decoder_seen_slot(decoder, encoding_symbol_id);
  }
  decoder->seen[slot] = encoding_symbol_id;
  return 1;
}

static uint32_t decoder_symbol_row(const nanorq_decoder *decoder,
                                   const nanorq_core *core,
                                   uint32_t index) {
  return index < decoder->source_symbols
             ? index
             : core->P.Kprime + index - decoder->source_symbols;
}

static bool decoder_populate_matrix(nanorq_decoder *decoder,
                                    nanorq_core *core, uint8_t *matrix) {
  size_t source_bytes;
  if (!checked_size_multiply(decoder->source_symbols, decoder->stride,
                             &source_bytes))
    return false;
  memcpy(nanorq_core_get_symbol_ptr(core, matrix, decoder->stride, 0),
         nanorq_core_get_symbol_ptr(&decoder->initial_core,
                                    decoder->initial_matrix,
                                    decoder->stride, 0),
         source_bytes);

  uint32_t overhead = decoder->received - decoder->source_symbols;
  if (overhead == 0)
    return true;
  uint8_t *destination = nanorq_core_get_symbol_ptr(
      core, matrix, decoder->stride, core->P.Kprime);
  if (decoder->stride == decoder->symbol_size) {
    size_t overhead_bytes;
    if (!checked_size_multiply(overhead, decoder->symbol_size,
                               &overhead_bytes))
      return false;
    memcpy(destination, decoder->overhead_payloads, overhead_bytes);
    return true;
  }
  for (uint32_t index = 0; index < overhead; index++) {
    nanorq_core_place_symbol(
        core, matrix, decoder->stride, core->P.Kprime + index,
        decoder->overhead_payloads + (size_t)index * decoder->symbol_size,
        decoder->symbol_size);
  }
  return true;
}

/* Return 1 on recovery, 0 when another independent repair symbol is needed,
 * and -1 on an allocation or internal error. */
static int decoder_attempt(nanorq_decoder *decoder, uint8_t *output) {
  uint32_t overhead = decoder->received - decoder->source_symbols;
  bool initial_attempt = overhead == 0;
  nanorq_core rebuilt_core = {0};
  nanorq_core *core = &decoder->initial_core;
  uint8_t *prepare = NULL;
  uint8_t *matrix = decoder->initial_matrix;
  uint8_t *work = NULL;
  uint8_t *scratch = NULL;
  void *schedule_memory = NULL;
  schedule operations = {0};
  struct nanorq_core_mem_reqs requirements;
  int result = -1;

  if (!initial_attempt) {
    core = &rebuilt_core;
    if (!nanorq_core_encoder_new(decoder->source_symbols, overhead, core))
      goto cleanup;
  }
  if (!codec_memory_requirements(decoder->source_symbols, overhead,
                                 decoder->stride, &requirements))
    goto cleanup;

  if (!initial_attempt) {
    prepare = malloc(requirements.prepare_bytes);
    if (!prepare || !nanorq_core_prepare(core, prepare,
                                         requirements.prepare_bytes))
      goto cleanup;
    for (uint32_t index = 0; index < decoder->received; index++) {
      nanorq_core_replace_symbol(core,
                                 decoder_symbol_row(decoder, core, index),
                                 decoder->encoding_symbol_ids[index]);
    }
    matrix = allocate_matrix(core, decoder->stride);
    if (!matrix)
      goto cleanup;
    /* Keep D populated before precalculate; the generated operation schedule
     * is validated against this input-row layout by the decoder regressions. */
    if (!decoder_populate_matrix(decoder, core, matrix))
      goto cleanup;
  }
  if (!nanorq_core_patch_matrix(core))
    goto cleanup;

  work = malloc(requirements.work_bytes);
  schedule_memory = malloc(requirements.schedule_bytes);
  if (!work || !schedule_memory ||
      !schedule_init(&operations, schedule_memory,
                     requirements.schedule_bytes))
    goto cleanup;
  nanorq_core_set_op_callback(core, &operations, ops_push);
  if (!nanorq_core_precalculate(core, work, requirements.work_bytes)) {
    result = operations.overflowed ? -1 : 0;
    goto cleanup;
  }
  if (operations.overflowed || operations.cpidx != 2)
    goto cleanup;

  bool needs_scratch = decoder->stride != decoder->symbol_size ||
                       decoder->transfer_length % decoder->symbol_size != 0;
  scratch = needs_scratch ? malloc(decoder->stride) : NULL;
  if (needs_scratch && !scratch)
    goto cleanup;

  ops_run(core, matrix, decoder->stride, &operations);

  uint32_t written = 0;
  for (uint32_t encoding_symbol_id = 0;
       encoding_symbol_id < decoder->source_symbols;
       encoding_symbol_id++) {
    uint32_t remaining = decoder->transfer_length - written;
    uint32_t copied =
        remaining < decoder->symbol_size ? remaining : decoder->symbol_size;
    uint8_t *destination = copied == decoder->stride
                               ? output + written
                               : scratch;
    ops_mix(core, matrix, decoder->stride, encoding_symbol_id, destination);
    if (destination == scratch)
      memcpy(output + written, scratch, copied);
    written += copied;
  }
  result = written == decoder->transfer_length ? 1 : -1;

cleanup:
  free(scratch);
  free(schedule_memory);
  free(work);
  if (!initial_attempt)
    obl_free(matrix);
  free(prepare);
  return result;
}

EMSCRIPTEN_KEEPALIVE uint8_t *
nanorq_decoder_input(nanorq_decoder *decoder) {
  if (!decoder || decoder->complete || !decoder_grow(decoder))
    return NULL;
  decoder->input_ready = true;
  return decoder->input_packet;
}

EMSCRIPTEN_KEEPALIVE int
nanorq_decoder_commit(nanorq_decoder *decoder, uint8_t *output,
                      uint32_t output_length) {
  if (!decoder || !decoder->input_ready || !output ||
      output_length != decoder->transfer_length)
    return -1;
  decoder->input_ready = false;
  if (decoder->complete)
    return 1;

  uint8_t *packet = decoder->input_packet;
  if (packet[0] != 0)
    return -1;

  uint32_t encoding_symbol_id = packet_encoding_symbol_id(packet);
  if (encoding_symbol_id < decoder->source_symbols)
    return -1;
  int inserted = decoder_seen_insert(decoder, encoding_symbol_id);
  if (inserted <= 0)
    return inserted;

  uint32_t index = decoder->received++;
  decoder->encoding_symbol_ids[index] = encoding_symbol_id;
  if (index < decoder->source_symbols) {
    nanorq_core_replace_symbol(&decoder->initial_core, index,
                               encoding_symbol_id);
    nanorq_core_place_symbol(&decoder->initial_core,
                             decoder->initial_matrix, decoder->stride,
                             index, packet + PAYLOAD_ID_BYTES,
                             decoder->symbol_size);
  } else {
    memcpy(decoder->overhead_payloads +
               (size_t)(index - decoder->source_symbols) *
                   decoder->symbol_size,
           packet + PAYLOAD_ID_BYTES, decoder->symbol_size);
  }
  if (decoder->received < decoder->source_symbols)
    return 0;

  int result = decoder_attempt(decoder, output);
  if (result > 0)
    decoder->complete = true;
  return result;
}

EMSCRIPTEN_KEEPALIVE void nanorq_decoder_free(nanorq_decoder *decoder) {
  decoder_release(decoder);
}

EMSCRIPTEN_KEEPALIVE nanorq_qr *nanorq_qr_new(void) {
  /* The SIMD AXPY kernel uses the reference multiplication table for its
   * sub-16-byte tail. Initialize that table even when QR generation is the
   * first operation performed by a fresh module instance. */
  struct oblas_impl implementation;
  oblas_get_impl(&implementation);
  return calloc(1, sizeof(nanorq_qr));
}

EMSCRIPTEN_KEEPALIVE uint32_t nanorq_qr_input_capacity(void) {
  return qrcodegen_BUFFER_LEN_MAX;
}

EMSCRIPTEN_KEEPALIVE uint8_t *nanorq_qr_input(nanorq_qr *qr) {
  return qr ? qr->data_and_temp : NULL;
}

EMSCRIPTEN_KEEPALIVE uint8_t *nanorq_qr_packed(nanorq_qr *qr) {
  /* Nayuki stores the side length in byte 0 and module bits from byte 1. */
  return qr ? qr->encoded + 1 : NULL;
}

EMSCRIPTEN_KEEPALIVE int nanorq_qr_encode(nanorq_qr *qr, size_t data_length,
                                         int ecc, int min_version,
                                         int max_version, int mask) {
  if (!qr || data_length > qrcodegen_BUFFER_LEN_MAX || ecc < 0 || ecc > 3 ||
      min_version < qrcodegen_VERSION_MIN || max_version > qrcodegen_VERSION_MAX ||
      min_version > max_version || mask != qrcodegen_Mask_3)
    return 0;

  if (!qrcodegen_encodeBinaryFixedMask3(
          qr->data_and_temp, data_length, qr->encoded,
          (enum qrcodegen_Ecc)ecc, min_version, max_version, &qr->cache))
    return 0;

  return qrcodegen_getSize(qr->encoded);
}

EMSCRIPTEN_KEEPALIVE void nanorq_qr_free(nanorq_qr *qr) {
  free(qr);
}

static uint8_t gf256_multiply(uint8_t left, uint8_t right) {
  uint8_t result = 0;
  while (right != 0) {
    if (right & 1)
      result ^= left;
    bool high = (left & 0x80) != 0;
    left <<= 1;
    if (high)
      left ^= 0x1d;
    right >>= 1;
  }
  return result;
}

EMSCRIPTEN_KEEPALIVE int nanorq_simd_enabled(void) {
#if defined(__wasm_simd128__)
  return 1;
#else
  return 0;
#endif
}

/* Deterministically compare every coefficient and aligned/unaligned tails
 * against independent scalar implementations. */
EMSCRIPTEN_KEEPALIVE int nanorq_simd_self_test(void) {
  static const unsigned lengths[] = {1,  7,  15, 16, 17, 31, 32,
                                     33, 63, 64, 65, 2928};
  struct oblas_impl implementation;
  oblas_get_impl(&implementation);
  uint8_t source[2931];
  uint8_t expected[2931];
  uint8_t actual[2931];
  uint32_t packed_bits[(2931 + 31) / 32];

  for (unsigned scalar = 0; scalar <= 255; scalar++) {
    for (unsigned length_index = 0;
         length_index < sizeof(lengths) / sizeof(lengths[0]);
         length_index++) {
      unsigned length = lengths[length_index];
      for (unsigned index = 0; index < length + 3; index++) {
        source[index] = (uint8_t)(index * 73u + scalar * 11u + 17u);
        expected[index] = (uint8_t)(index * 29u + scalar * 7u + 41u);
        actual[index] = expected[index];
      }
      for (unsigned index = 0; index < length; index++)
        expected[index + 1] ^=
            gf256_multiply((uint8_t)scalar, source[index + 1]);
      implementation.axpy(actual + 1, source + 1, (uint8_t)scalar, length);
      if (memcmp(actual, expected, length + 3) != 0)
        return 0;

      for (unsigned index = 0; index < length + 3; index++) {
        expected[index] = 0xa5;
        actual[index] = 0xa5;
      }
      for (unsigned index = 0; index < length; index++)
        expected[index + 1] =
            gf256_multiply((uint8_t)scalar, source[index + 1]);
      implementation.axiy(actual + 1, source + 1, (uint8_t)scalar, length);
      if (memcmp(actual, expected, length + 3) != 0)
        return 0;

      memcpy(actual, source, length + 3);
      memcpy(expected, source, length + 3);
      for (unsigned index = 0; index < length; index++)
        expected[index + 1] =
            gf256_multiply((uint8_t)scalar, expected[index + 1]);
      implementation.scal(actual + 1, (uint8_t)scalar, length);
      if (memcmp(actual, expected, length + 3) != 0)
        return 0;

      for (unsigned word = 0;
           word < sizeof(packed_bits) / sizeof(packed_bits[0]); word++)
        packed_bits[word] =
            0xa5c39e71u ^ (word * 0x9e3779b9u) ^ (scalar * 0x01010101u);
      for (unsigned index = 0; index < length + 3; index++) {
        expected[index] = (uint8_t)(index * 29u + scalar * 7u + 41u);
        actual[index] = expected[index];
      }
      /* Keep the oracle scalar so it cannot share a vector-codegen bug with
       * the backend under test. */
#pragma clang loop vectorize(disable)
      for (unsigned index = 0; index < length; index++) {
        if ((packed_bits[index / 32] >> (index % 32)) & 1u)
          expected[index + 1] ^= (uint8_t)scalar;
      }
      implementation.axpyb32(actual + 1, packed_bits, (uint8_t)scalar,
                             length);
      if (memcmp(actual, expected, length + 3) != 0)
        return 0;
    }
  }
  return 1;
}
