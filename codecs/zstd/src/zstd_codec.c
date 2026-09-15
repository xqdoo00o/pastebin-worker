#include <stdint.h>
#include <stdlib.h>

#define ZSTD_STATIC_LINKING_ONLY
#include "zstd.h"
#include "zstd_errors.h"

#if !defined(PW_ZSTD_ENCODER) && !defined(PW_ZSTD_DECODER)
#error "define PW_ZSTD_ENCODER or PW_ZSTD_DECODER"
#endif

enum {
    PW_ZSTD_OK = 0,
    PW_ZSTD_STATE_ERROR = 1,
    PW_ZSTD_ALLOCATION_ERROR = 2,
    PW_ZSTD_OUTPUT_LIMIT_ERROR = 3,
    PW_ZSTD_TRUNCATED_ERROR = 4,
    PW_ZSTD_LEVEL_ERROR = 5,
    PW_ZSTD_STREAMING_REQUIRED = 6,
    PW_ZSTD_LIBRARY_ERROR_BASE = 1000,
};

#ifdef PW_ZSTD_ENCODER
#define PW_ZSTD_MAX_COMPRESSION_LEVEL 4
/* One-shot calls are synchronous within one WASM instance. Retain zstd's
 * workspace for subsequent calls and let instance teardown reclaim it. */
static ZSTD_CCtx *pw_zstd_one_shot_compression_context;
#endif

#ifdef PW_ZSTD_DECODER
/* Keep the decoder compatible with zstd's recommended minimum 8 MiB window,
 * while never widening its normal 128 MiB streaming limit. */
#define PW_ZSTD_MIN_WINDOW_SIZE ((size_t)1 << 23)
#define PW_ZSTD_DEFAULT_MAX_WINDOW_SIZE ((size_t)1 << ZSTD_WINDOWLOG_LIMIT_DEFAULT)
static ZSTD_DCtx *pw_zstd_one_shot_decompression_context;
#endif

typedef struct {
    uint8_t *data;
    size_t size;
    size_t capacity;
    int error;
} PwZstdOutput;

#ifdef PW_ZSTD_ENCODER
typedef struct {
    ZSTD_CCtx *context;
    PwZstdOutput output;
    int finished;
} PwZstdCompressor;
#endif

#ifdef PW_ZSTD_DECODER
typedef struct {
    ZSTD_DCtx *context;
    PwZstdOutput output;
    size_t max_output;
    size_t total_output;
    size_t last_result;
    int finished;
} PwZstdDecompressor;
#endif

static int library_error(size_t result)
{
    return PW_ZSTD_LIBRARY_ERROR_BASE + (int)ZSTD_getErrorCode(result);
}

static int reserve_output(PwZstdOutput *output, size_t additional)
{
    if (additional > SIZE_MAX - output->size) {
        output->error = PW_ZSTD_ALLOCATION_ERROR;
        return output->error;
    }
    const size_t required = output->size + additional;
    if (required <= output->capacity) {
        return PW_ZSTD_OK;
    }

    size_t capacity = output->capacity == 0 ? additional : output->capacity;
    while (capacity < required) {
        const size_t grown = capacity + capacity / 2 + 1;
        if (grown <= capacity) {
            capacity = required;
            break;
        }
        capacity = grown;
    }
    uint8_t *const data = (uint8_t *)realloc(output->data, capacity);
    if (data == NULL) {
        output->error = PW_ZSTD_ALLOCATION_ERROR;
        return output->error;
    }
    output->data = data;
    output->capacity = capacity;
    return PW_ZSTD_OK;
}

static void clear_output(PwZstdOutput *output)
{
    output->size = 0;
}

static void free_output(PwZstdOutput *output)
{
    free(output->data);
}

#ifdef PW_ZSTD_ENCODER
uint32_t pw_zstd_compress_bound(uint32_t input_size)
{
    const size_t result = ZSTD_compressBound(input_size);
    return result > UINT32_MAX ? 0 : (uint32_t)result;
}

int pw_zstd_compress(
    const uint8_t *input,
    uint32_t input_size,
    uint8_t *output,
    uint32_t output_capacity,
    int level,
    uint32_t *written)
{
    if (level < ZSTD_minCLevel() || level > PW_ZSTD_MAX_COMPRESSION_LEVEL) {
        return PW_ZSTD_LEVEL_ERROR;
    }
    if (pw_zstd_one_shot_compression_context == NULL) {
        pw_zstd_one_shot_compression_context = ZSTD_createCCtx();
        if (pw_zstd_one_shot_compression_context == NULL) {
            return PW_ZSTD_ALLOCATION_ERROR;
        }
    }
    const size_t result = ZSTD_compressCCtx(
        pw_zstd_one_shot_compression_context,
        output,
        output_capacity,
        input,
        input_size,
        level);
    if (ZSTD_isError(result)) {
        return library_error(result);
    }
    *written = (uint32_t)result;
    return PW_ZSTD_OK;
}
#endif

const char *pw_zstd_error_name(int error)
{
    switch (error) {
        case PW_ZSTD_OK:
            return "No error";
        case PW_ZSTD_STATE_ERROR:
            return "streaming context is already finished";
        case PW_ZSTD_ALLOCATION_ERROR:
            return "WebAssembly memory allocation failed";
        case PW_ZSTD_OUTPUT_LIMIT_ERROR:
            return "decompressed output exceeds its configured limit";
        case PW_ZSTD_TRUNCATED_ERROR:
            return "compressed stream ended before the frame was complete";
        case PW_ZSTD_LEVEL_ERROR:
            return "compression level must be an integer no greater than 4";
        case PW_ZSTD_STREAMING_REQUIRED:
            return "streaming decompression is required";
        default:
            if (error >= PW_ZSTD_LIBRARY_ERROR_BASE) {
                return ZSTD_getErrorString((ZSTD_ErrorCode)(error - PW_ZSTD_LIBRARY_ERROR_BASE));
            }
            return "unknown zstd codec error";
    }
}

#ifdef PW_ZSTD_ENCODER
PwZstdCompressor *pw_zstd_compressor_new(int level, double pledged_size, int has_pledged_size)
{
    PwZstdCompressor *const compressor = (PwZstdCompressor *)calloc(1, sizeof(*compressor));
    if (compressor == NULL) {
        return NULL;
    }
    if (level < ZSTD_minCLevel() || level > PW_ZSTD_MAX_COMPRESSION_LEVEL) {
        compressor->output.error = PW_ZSTD_LEVEL_ERROR;
        return compressor;
    }
    compressor->context = ZSTD_createCCtx();
    if (compressor->context == NULL) {
        free(compressor);
        return NULL;
    }
    const size_t result = ZSTD_CCtx_setParameter(compressor->context, ZSTD_c_compressionLevel, level);
    if (ZSTD_isError(result)) {
        compressor->output.error = library_error(result);
        return compressor;
    }
#ifdef PW_ZSTD_WORKERS
    if (PW_ZSTD_WORKERS > 0) {
        const size_t workers_result = ZSTD_CCtx_setParameter(
            compressor->context, ZSTD_c_nbWorkers, PW_ZSTD_WORKERS);
        if (ZSTD_isError(workers_result)) {
            compressor->output.error = library_error(workers_result);
            return compressor;
        }
    }
#endif
    if (has_pledged_size) {
        /* JavaScript represents Blob/File sizes exactly through 2^53 - 1.
         * Accept the value as f64 at the WASM boundary so streaming ZIP64
         * entries are not artificially limited to 32 bits. */
        const size_t pledge_result = ZSTD_CCtx_setPledgedSrcSize(
            compressor->context,
            (unsigned long long)pledged_size);
        if (ZSTD_isError(pledge_result)) {
            compressor->output.error = library_error(pledge_result);
        }
    }
    return compressor;
}

void pw_zstd_compressor_free(PwZstdCompressor *compressor)
{
    if (compressor == NULL) {
        return;
    }
    ZSTD_freeCCtx(compressor->context);
    free_output(&compressor->output);
    free(compressor);
}

static int compress_stream(
    PwZstdCompressor *compressor,
    const uint8_t *input_bytes,
    size_t input_size,
    ZSTD_EndDirective directive)
{
    if (compressor == NULL || compressor->finished) {
        return PW_ZSTD_STATE_ERROR;
    }
    if (compressor->output.error != PW_ZSTD_OK) {
        return compressor->output.error;
    }
    clear_output(&compressor->output);
    ZSTD_inBuffer input = {input_bytes, input_size, 0};
    const size_t chunk_capacity = ZSTD_CStreamOutSize();
    size_t reserve_size = chunk_capacity;
    size_t remaining = 1;
    do {
        const int reserve = reserve_output(&compressor->output, reserve_size);
        if (reserve != PW_ZSTD_OK) {
            return reserve;
        }
        ZSTD_outBuffer output = {
            compressor->output.data + compressor->output.size,
            compressor->output.capacity - compressor->output.size,
            0,
        };
        remaining = ZSTD_compressStream2(compressor->context, &output, &input, directive);
        if (ZSTD_isError(remaining)) {
            compressor->output.error = library_error(remaining);
            return compressor->output.error;
        }
        compressor->output.size += output.pos;

        /* If a recommended-size output buffer did not consume the input, the
         * data is probably poorly compressible. Reserve enough room for the
         * unconsumed bytes in one step instead of repeatedly growing by 50%. */
        reserve_size = chunk_capacity;
        if (input.pos < input.size) {
            const size_t unconsumed = input.size - input.pos;
            if (unconsumed <= SIZE_MAX - chunk_capacity) {
                reserve_size = unconsumed + chunk_capacity;
            }
        }
    } while (input.pos < input.size || (directive != ZSTD_e_continue && remaining != 0));

    if (directive == ZSTD_e_end) {
        compressor->finished = 1;
    }
    return PW_ZSTD_OK;
}

int pw_zstd_compressor_push(PwZstdCompressor *compressor, const uint8_t *input, uint32_t input_size)
{
    return compress_stream(compressor, input, input_size, ZSTD_e_continue);
}

int pw_zstd_compressor_finish(PwZstdCompressor *compressor)
{
    return compress_stream(compressor, NULL, 0, ZSTD_e_end);
}

const uint8_t *pw_zstd_compressor_output(const PwZstdCompressor *compressor)
{
    return compressor == NULL ? NULL : compressor->output.data;
}

uint32_t pw_zstd_compressor_output_size(const PwZstdCompressor *compressor)
{
    return compressor == NULL || compressor->output.size > UINT32_MAX ? 0 : (uint32_t)compressor->output.size;
}
#endif

#ifdef PW_ZSTD_DECODER
int pw_zstd_decompress_capacity(
    const uint8_t *input,
    uint32_t input_size,
    uint32_t max_output,
    uint32_t *capacity)
{
    const unsigned long long decompressed_size = ZSTD_findDecompressedSize(input, input_size);
    if (decompressed_size != ZSTD_CONTENTSIZE_UNKNOWN && decompressed_size != ZSTD_CONTENTSIZE_ERROR) {
        if (decompressed_size > max_output) {
            return PW_ZSTD_OUTPUT_LIMIT_ERROR;
        }
        *capacity = (uint32_t)decompressed_size;
        return PW_ZSTD_OK;
    }
    return PW_ZSTD_STREAMING_REQUIRED;
}

int pw_zstd_decompress(
    const uint8_t *input,
    uint32_t input_size,
    uint8_t *output,
    uint32_t output_capacity,
    uint32_t *written)
{
    if (pw_zstd_one_shot_decompression_context == NULL) {
        pw_zstd_one_shot_decompression_context = ZSTD_createDCtx();
        if (pw_zstd_one_shot_decompression_context == NULL) {
            return PW_ZSTD_ALLOCATION_ERROR;
        }
    }
    const size_t result = ZSTD_decompressDCtx(
        pw_zstd_one_shot_decompression_context,
        output,
        output_capacity,
        input,
        input_size);
    if (ZSTD_isError(result)) {
        return ZSTD_getErrorCode(result) == ZSTD_error_dstSize_tooSmall
            ? PW_ZSTD_OUTPUT_LIMIT_ERROR
            : library_error(result);
    }
    *written = (uint32_t)result;
    return PW_ZSTD_OK;
}

PwZstdDecompressor *pw_zstd_decompressor_new(uint32_t max_output)
{
    PwZstdDecompressor *const decompressor = (PwZstdDecompressor *)calloc(1, sizeof(*decompressor));
    if (decompressor == NULL) {
        return NULL;
    }
    decompressor->context = ZSTD_createDCtx();
    if (decompressor->context == NULL) {
        free(decompressor);
        return NULL;
    }
    size_t max_window_size = max_output;
    if (max_window_size < PW_ZSTD_MIN_WINDOW_SIZE) {
        max_window_size = PW_ZSTD_MIN_WINDOW_SIZE;
    } else if (max_window_size > PW_ZSTD_DEFAULT_MAX_WINDOW_SIZE) {
        max_window_size = PW_ZSTD_DEFAULT_MAX_WINDOW_SIZE;
    }
    const size_t window_result = ZSTD_DCtx_setMaxWindowSize(decompressor->context, max_window_size);
    if (ZSTD_isError(window_result)) {
        decompressor->output.error = library_error(window_result);
    }
    decompressor->max_output = max_output;
    decompressor->last_result = 1;
    return decompressor;
}

void pw_zstd_decompressor_free(PwZstdDecompressor *decompressor)
{
    if (decompressor == NULL) {
        return;
    }
    ZSTD_freeDCtx(decompressor->context);
    free_output(&decompressor->output);
    free(decompressor);
}

int pw_zstd_decompressor_push(PwZstdDecompressor *decompressor, const uint8_t *input_bytes, uint32_t input_size)
{
    if (decompressor == NULL || decompressor->finished) {
        return PW_ZSTD_STATE_ERROR;
    }
    if (decompressor->output.error != PW_ZSTD_OK) {
        return decompressor->output.error;
    }
    clear_output(&decompressor->output);
    if (input_size == 0) {
        return PW_ZSTD_OK;
    }
    ZSTD_inBuffer input = {input_bytes, input_size, 0};
    const size_t chunk_capacity = ZSTD_DStreamOutSize();
    size_t result = decompressor->last_result;

    do {
        const size_t output_remaining = decompressor->max_output - decompressor->total_output;
        const size_t write_capacity = output_remaining < chunk_capacity
            ? output_remaining + 1
            : chunk_capacity;
        const int reserve = reserve_output(&decompressor->output, write_capacity);
        if (reserve != PW_ZSTD_OK) {
            return reserve;
        }
        ZSTD_outBuffer output = {
            decompressor->output.data + decompressor->output.size,
            write_capacity,
            0,
        };
        result = ZSTD_decompressStream(decompressor->context, &output, &input);
        if (ZSTD_isError(result)) {
            decompressor->output.error = library_error(result);
            return decompressor->output.error;
        }
        if (output.pos > decompressor->max_output - decompressor->total_output) {
            decompressor->output.error = PW_ZSTD_OUTPUT_LIMIT_ERROR;
            return decompressor->output.error;
        }
        decompressor->output.size += output.pos;
        decompressor->total_output += output.pos;

        const int output_was_full = output.pos == output.size;
        if (input.pos >= input.size && (!output_was_full || result == 0)) {
            break;
        }
    } while (input.pos < input.size || result != 0);

    decompressor->last_result = result;
    return PW_ZSTD_OK;
}

int pw_zstd_decompressor_finish(PwZstdDecompressor *decompressor)
{
    if (decompressor == NULL || decompressor->finished) {
        return PW_ZSTD_STATE_ERROR;
    }
    decompressor->finished = 1;
    clear_output(&decompressor->output);
    return decompressor->last_result == 0
        ? PW_ZSTD_OK
        : PW_ZSTD_TRUNCATED_ERROR;
}

const uint8_t *pw_zstd_decompressor_output(const PwZstdDecompressor *decompressor)
{
    return decompressor == NULL ? NULL : decompressor->output.data;
}

uint32_t pw_zstd_decompressor_output_size(const PwZstdDecompressor *decompressor)
{
    return decompressor == NULL || decompressor->output.size > UINT32_MAX ? 0 : (uint32_t)decompressor->output.size;
}
#endif
