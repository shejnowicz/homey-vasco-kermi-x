'use strict';

const Homey = require('homey');

const { VascoAccountRegistry } = require('../../lib/vasco-account-registry');
const { VascoApiClient } = require('../../lib/vasco-api-client');
const {
  assertSupportedDevice,
  discoverVentilationDevices,
} = require('../../lib/vasco-device-mapper');

const LOGIN_ERROR = 'Could not sign in to Vasco. Check your credentials and try again.';
const LIST_ERROR = 'Could not list Vasco ventilation units. Please try again.';
const DEFAULT_PRODUCT = 'Vasco ventilation unit';

class CompatibilityError extends Error {}

module.exports = class VascoKermiXDriver extends Homey.Driver {
  createPairRegistry() {
    return new VascoAccountRegistry({
      apiClientFactory: () => new VascoApiClient(),
    });
  }

  onPair(session) {
    const registry = this.createPairRegistry();
    let pairState = null;
    let loginInProgress = false;
    let disconnected = false;

    const clearPairState = () => {
      if (pairState === null) return;

      const accountKey = pairState.accountKey;
      pairState.password = null;
      pairState.email = null;
      pairState.configuration = null;
      pairState = null;
      try {
        registry.release(accountKey);
      } catch {
        // Pair cleanup must not expose account details or replace the user-facing result.
      }
    };

    session.setHandler('disconnect', () => {
      disconnected = true;
      clearPairState();
    });

    session.setHandler('login', async (credentials) => {
      if (loginInProgress || disconnected) {
        throw new Error(LOGIN_ERROR);
      }
      clearPairState();

      const email = normalizeEmail(credentials?.email);
      const password = credentials?.password;
      if (email === null || typeof password !== 'string' || password.length === 0) {
        throw new Error(LOGIN_ERROR);
      }

      loginInProgress = true;
      let service;
      try {
        service = registry.acquire({ email, password });
        const configuration = await service.readConfiguration();
        if (disconnected) {
          throw new Error(LOGIN_ERROR);
        }
        pairState = {
          accountKey: service.accountKey,
          configuration,
          email,
          password,
        };
        return true;
      } catch {
        if (service) {
          try {
            registry.release(service.accountKey);
          } catch {
            // Authentication failures are deliberately returned as one redacted error.
          }
        }
        throw new Error(LOGIN_ERROR);
      } finally {
        loginInProgress = false;
      }
    });

    session.setHandler('list_devices', async () => {
      if (pairState === null) {
        throw new Error('Sign in to Vasco before listing ventilation units.');
      }

      const state = pairState;
      try {
        const candidates = discoverVentilationDevices(state.configuration);
        if (candidates.length === 0) {
          const malformed = findMalformedVentilationCandidate(state.configuration);
          if (malformed) {
            throw compatibilityError(malformed, state);
          }
        }

        const pairedIdentities = new Set(
          this.getDevices()
            .map(device => device.getData()?.id)
            .filter(identity => typeof identity === 'string'),
        );

        return candidates
          .filter(candidate => !pairedIdentities.has(candidate.identity))
          .map(candidate => ({
            name: safeDisplayName(candidate, state),
            data: { id: candidate.identity },
            settings: {
              vasco_email: state.email,
              vasco_password: state.password,
            },
            store: { product: safeProduct(candidate.raw, state) },
          }));
      } catch (error) {
        if (error instanceof CompatibilityError) throw error;
        throw new Error(LIST_ERROR);
      }
    });
  }
};

function findMalformedVentilationCandidate(configuration) {
  const properties = Array.isArray(configuration?.deviceProperties)
    ? configuration.deviceProperties
    : [];

  return properties.find((raw) => {
    if (typeof raw?.productCategory !== 'string'
      || raw.productCategory.toLowerCase() !== 'ventilation') {
      return false;
    }

    try {
      assertSupportedDevice(raw);
      return false;
    } catch {
      return true;
    }
  });
}

function compatibilityError(raw, credentials) {
  const product = safeProduct(raw, credentials);
  return new CompatibilityError(
    `${product} is not yet compatible. Please report this model through the project support page.`,
  );
}

function safeDisplayName(candidate, credentials) {
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  if (name.length > 0 && !containsPrivateValue(name, candidate.raw, credentials)) {
    return name;
  }
  const product = safeProduct(candidate.raw, credentials);
  return product === DEFAULT_PRODUCT ? product : `${product} ventilation unit`;
}

function safeProduct(raw, credentials) {
  const rawProduct = raw?.productTypeString ?? raw?.product;
  const product = typeof rawProduct === 'string' ? rawProduct.trim() : '';
  if (product.length === 0 || containsPrivateValue(product, raw, credentials)) {
    return DEFAULT_PRODUCT;
  }
  return product;
}

function containsPrivateValue(value, raw, credentials) {
  const lowerValue = value.toLowerCase();
  const caseInsensitiveValues = [
    raw?.macAddress,
    raw?.serial,
    raw?.bridgeId,
    raw?.deviceId,
    credentials?.email,
  ];
  if (caseInsensitiveValues.some(privateValue => (
    typeof privateValue === 'string'
      && privateValue.length > 0
      && lowerValue.includes(privateValue.toLowerCase())
  ))) {
    return true;
  }

  const password = credentials?.password;
  return typeof password === 'string'
    && password.length > 0
    && value.includes(password);
}

function normalizeEmail(email) {
  if (typeof email !== 'string' || email.trim().length === 0) return null;
  return email.trim();
}
