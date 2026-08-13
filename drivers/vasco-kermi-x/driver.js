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

    session.setHandler('login', async (credentials) => {
      clearPairState();

      const email = normalizeEmail(credentials?.email);
      const password = credentials?.password;
      if (email === null || typeof password !== 'string' || password.length === 0) {
        throw new Error(LOGIN_ERROR);
      }

      let service;
      try {
        service = registry.acquire({ email, password });
        const configuration = await service.readConfiguration();
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
            throw compatibilityError(malformed);
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
            name: safeDisplayName(candidate),
            data: { id: candidate.identity },
            settings: {
              vasco_email: state.email,
              vasco_password: state.password,
            },
            store: { product: safeProduct(candidate.raw) },
          }));
      } catch (error) {
        if (error instanceof CompatibilityError) throw error;
        throw new Error(LIST_ERROR);
      } finally {
        clearPairState();
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

function compatibilityError(raw) {
  const product = safeProduct(raw);
  return new CompatibilityError(
    `${product} is not yet compatible. Please report this model through the project support page.`,
  );
}

function safeDisplayName(candidate) {
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  if (name.length > 0
    && !name.includes(candidate.bridgeRef)
    && !name.includes(candidate.deviceRef)) {
    return name;
  }
  return `${safeProduct(candidate.raw)} ventilation unit`;
}

function safeProduct(raw) {
  const product = typeof raw?.product === 'string' ? raw.product.trim() : '';
  if (product.length === 0
    || (typeof raw?.bridgeId === 'string' && product.includes(raw.bridgeId))
    || (typeof raw?.deviceId === 'string' && product.includes(raw.deviceId))) {
    return 'Vasco ventilation unit';
  }
  return product;
}

function normalizeEmail(email) {
  if (typeof email !== 'string' || email.trim().length === 0) return null;
  return email.trim();
}
