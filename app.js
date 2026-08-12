'use strict';

const Homey = require('homey');

module.exports = class VascoKermiXApp extends Homey.App {
  async onInit() {
    this.log('Vasco/Kermi X Series app has been initialized');
  }
};
