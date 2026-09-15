#include <stddef.h>
#include <stdint.h>

#include "xxhash.h"

uint64_t pw_xxh3_64bits(const void *input, size_t length)
{
    return XXH3_64bits(input, length);
}

XXH3_state_t *pw_xxh3_state_new(void)
{
    XXH3_state_t *state = XXH3_createState();
    if (state == NULL) return NULL;
    if (XXH3_64bits_reset(state) != XXH_OK) {
        XXH3_freeState(state);
        return NULL;
    }
    return state;
}

void pw_xxh3_state_free(XXH3_state_t *state)
{
    XXH3_freeState(state);
}

int pw_xxh3_state_reset(XXH3_state_t *state)
{
    return (int)XXH3_64bits_reset(state);
}

int pw_xxh3_state_update(XXH3_state_t *state, const void *input, size_t length)
{
    return (int)XXH3_64bits_update(state, input, length);
}

uint64_t pw_xxh3_state_digest(const XXH3_state_t *state)
{
    return XXH3_64bits_digest(state);
}
