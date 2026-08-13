'use strict';

const Homey = require('homey');
const { VascoAccountRegistry } = require('./lib/vasco-account-registry');
const { VascoApiClient } = require('./lib/vasco-api-client');
const { VascoAuthenticationError } = require('./lib/vasco-errors');

module.exports = class VascoKermiXApp extends Homey.App {
  async onInit() {
    const clock = {
      now: () => Date.now(),
      setTimeout: (fn, delayMs) => this.homey.setTimeout(fn, delayMs),
      clearTimeout: timer => this.homey.clearTimeout(timer),
    };
    this.vascoAccountRegistry = new VascoAccountRegistry({
      apiClientFactory: () => new VascoApiClient({ clock }),
      clock,
      notify: error => this.homey.notifications.createNotification({
        excerpt: error instanceof VascoAuthenticationError
          ? 'Vasco authentication failed; update the account credentials.'
          : 'A Vasco account operation needs attention.',
      }),
    });
    this.log('Vasco/Kermi X Series app has been initialized');
  }

  async onUninit() {
    this.vascoAccountRegistry?.close();
    this.vascoAccountRegistry = null;
  }
};
