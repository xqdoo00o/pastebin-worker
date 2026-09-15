#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#include "monocypher.h"

#define ARGON2_MEMORY_COST 8192u
#define ARGON2_TIME_COST 2u
#define ARGON2_PARALLELISM 1u
#define ARGON2_OUTPUT_LENGTH 32u
#define ARGON2_MAX_MEMORY_COST 65536u
#define ARGON2_MAX_TIME_COST 6u
#define ARGON2_MAX_PARALLELISM 4u

static int parse_number(const char **cursor, uint32_t *value, char delimiter) {
    uint64_t result = 0;
    const char *p = *cursor;
    if (*p < '0' || *p > '9') return 0;
    do {
        result = result * 10 + (uint32_t)(*p - '0');
        if (result > UINT32_MAX) return 0;
        p++;
    } while (*p >= '0' && *p <= '9');
    if (*p != delimiter) return 0;
    *value = (uint32_t)result;
    *cursor = p + 1;
    return 1;
}

static int base64_value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static size_t decode_base64(const char *input, size_t input_length, uint8_t *output) {
    uint32_t accumulator = 0;
    unsigned bits = 0;
    size_t output_length = 0;
    if (input_length % 4 == 1) return 0;
    for (size_t i = 0; i < input_length; i++) {
        const int value = base64_value(input[i]);
        if (value < 0) return 0;
        accumulator = (accumulator << 6) | (uint32_t)value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            output[output_length++] = (uint8_t)(accumulator >> bits);
        }
    }
    return output_length;
}

int argon2_monocypher_verify(const unsigned char *password, size_t password_length, const char *encoded_hash) {
    static const char prefix[] = "$argon2id$v=19$m=";
    const char *cursor;
    const char *salt_text;
    const char *hash_text;
    const char *separator;
    uint32_t memory_cost, time_cost, parallelism;
    size_t salt_text_length, hash_text_length, salt_length, hash_length;
    uint8_t *salt = NULL;
    uint8_t *expected = NULL;
    uint8_t *actual = NULL;
    void *work_area = NULL;
    int result = 0;

    if (!encoded_hash || strncmp(encoded_hash, prefix, sizeof(prefix) - 1) != 0) return 0;
    cursor = encoded_hash + sizeof(prefix) - 1;
    if (!parse_number(&cursor, &memory_cost, ',')) return 0;
    if (strncmp(cursor, "t=", 2) != 0) return 0;
    cursor += 2;
    if (!parse_number(&cursor, &time_cost, ',')) return 0;
    if (strncmp(cursor, "p=", 2) != 0) return 0;
    cursor += 2;
    if (!parse_number(&cursor, &parallelism, '$')) return 0;
    if (
        memory_cost > ARGON2_MAX_MEMORY_COST ||
        time_cost == 0 || time_cost > ARGON2_MAX_TIME_COST ||
        parallelism == 0 || parallelism > ARGON2_MAX_PARALLELISM ||
        memory_cost < 8 * parallelism
    ) return 0;
    salt_text = cursor;
    separator = strchr(salt_text, '$');
    if (!separator) return 0;
    salt_text_length = (size_t)(separator - salt_text);
    hash_text = separator + 1;
    hash_text_length = strlen(hash_text);
    if (salt_text_length == 0 || hash_text_length == 0 || password_length > UINT32_MAX) return 0;

    salt = malloc(salt_text_length * 3 / 4 + 3);
    expected = malloc(hash_text_length * 3 / 4 + 3);
    if (!salt || !expected) goto cleanup;
    salt_length = decode_base64(salt_text, salt_text_length, salt);
    hash_length = decode_base64(hash_text, hash_text_length, expected);
    if (!salt_length || !hash_length || hash_length > UINT32_MAX || memory_cost > SIZE_MAX / 1024) goto cleanup;

    actual = malloc(hash_length);
    work_area = malloc((size_t)memory_cost * 1024);
    if (!actual || !work_area) goto cleanup;
    crypto_argon2(
        actual,
        (uint32_t)hash_length,
        work_area,
        (crypto_argon2_config){CRYPTO_ARGON2_ID, memory_cost, time_cost, parallelism},
        (crypto_argon2_inputs){password, salt, (uint32_t)password_length, (uint32_t)salt_length},
        crypto_argon2_no_extras);

    unsigned difference = 0;
    for (size_t i = 0; i < hash_length; i++) difference |= actual[i] ^ expected[i];
    result = difference == 0;

cleanup:
    if (work_area) {
        free(work_area);
    }
    if (actual) {
        crypto_wipe(actual, hash_length);
        free(actual);
    }
    if (expected) {
        crypto_wipe(expected, hash_text_length * 3 / 4 + 3);
        free(expected);
    }
    if (salt) {
        crypto_wipe(salt, salt_text_length * 3 / 4 + 3);
        free(salt);
    }
    return result;
}

int argon2_monocypher_hash(const unsigned char *password, size_t password_length,
                           const unsigned char *salt, size_t salt_length,
                           unsigned char *output) {
    void *work_area;
    if (!password || !salt || !output || password_length > UINT32_MAX || salt_length > UINT32_MAX) return 0;

    work_area = malloc((size_t)ARGON2_MEMORY_COST * 1024);
    if (!work_area) return 0;
    crypto_argon2(
        output,
        ARGON2_OUTPUT_LENGTH,
        work_area,
        (crypto_argon2_config){CRYPTO_ARGON2_ID, ARGON2_MEMORY_COST, ARGON2_TIME_COST, ARGON2_PARALLELISM},
        (crypto_argon2_inputs){password, salt, (uint32_t)password_length, (uint32_t)salt_length},
        crypto_argon2_no_extras);
    free(work_area);
    return 1;
}
