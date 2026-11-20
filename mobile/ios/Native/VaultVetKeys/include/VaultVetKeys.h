#ifndef KINIC_VAULT_VETKEYS_H
#define KINIC_VAULT_VETKEYS_H
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
// Fixed-size buffers are owned by Swift; outputs must not overlap inputs.
int32_t kinic_vault_transport(const uint8_t seed[32], uint8_t secret[32], uint8_t public_key[48]);
int32_t kinic_vault_root(const uint8_t secret[32], const uint8_t *request, size_t length, bool local, uint8_t out[32]);
#endif
