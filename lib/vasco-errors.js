class VascoApiError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

class VascoAuthenticationError extends VascoApiError {}

class VascoTransportError extends VascoApiError {}

class VascoProtocolError extends VascoApiError {}

module.exports = {
  VascoAuthenticationError,
  VascoProtocolError,
  VascoTransportError,
};
