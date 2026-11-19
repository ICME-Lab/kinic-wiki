import { expect, it } from 'vitest';
import { validateConfig, type BrowserConfig } from './config';
const config: BrowserConfig = {
  canister: 'rrkah-fqaaa-aaaaa-aaaaq-cai',
  host: 'https://icp0.io',
  derivationOrigin: 'https://rrkah-fqaaa-aaaaa-aaaaq-cai.icp0.io',
  identityProvider: 'https://id.ai',
  origin: 'https://vault.kinic.xyz',
  local: false
};
it('accepts only Vault origins and its own stable canister derivation', () => {
  expect(validateConfig(config, config.origin)).toEqual(config);
  for (const bad of ['https://wiki.kinic.xyz', 'https://vault.kinic.xyz.evil.test', 'https://kinic.xyz']) expect(() => validateConfig(config, bad)).toThrow();
  expect(() => validateConfig({
    ...config,
    derivationOrigin: 'https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io'
  }, config.origin)).toThrow();
  expect(() => validateConfig({
    ...config,
    local: true
  }, config.origin)).toThrow();
});
it('requires separate exact local origin and local provider/replica', () => {
  const c = {
    ...config,
    host: 'http://127.0.0.1:8024',
    derivationOrigin: 'http://rrkah-fqaaa-aaaaa-aaaaq-cai.localhost:8024',
    identityProvider: 'http://rdmx6-jaaaa-aaaaa-aaadq-cai.localhost:8024',
    origin: 'http://vault.localhost:3024',
    local: true
  };
  expect(validateConfig(c, c.origin)).toEqual(c);
  expect(() => validateConfig(c, 'http://localhost:3010')).toThrow();
  expect(() => validateConfig({
    ...c,
    identityProvider: 'https://evil.test'
  }, c.origin)).toThrow();
});

it('accepts production funding and rejects unrecognized capability values', () => {
  expect(validateConfig({...config, fundingMode:'production'}, config.origin).fundingMode).toBe('production');
  expect(() => validateConfig({...config, fundingMode:'enabled' as any}, config.origin)).toThrow();
});

it("rejects arbitrary Wiki origins and accepts an explicit canonical loopback origin for local builds", () => {
  expect(() => validateConfig({ ...config, wikiOrigin: 'https://other.example' }, config.origin)).toThrow();
  const c = {
    ...config,
    host: 'http://127.0.0.1:8024',
    derivationOrigin: 'http://rrkah-fqaaa-aaaaa-aaaaq-cai.localhost:8024',
    identityProvider: 'http://rdmx6-jaaaa-aaaaa-aaadq-cai.localhost:8024',
    origin: 'http://vault.localhost:3024',
    local: true,
    wikiOrigin: 'http://wiki.localhost:3025'
  };
  expect(validateConfig(c, c.origin).wikiOrigin).toEqual(c.wikiOrigin);
  for (const wikiOrigin of ['https://wiki.kinic.xyz', 'http://wiki.localhost.evil.test', 'http://user@wiki.localhost:3025', 'http://localhost:3025/#x', 'http://localhost:3025/']) {
    expect(() => validateConfig({ ...c, wikiOrigin }, c.origin)).toThrow();
  }
});
