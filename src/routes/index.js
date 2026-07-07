'use strict';
const registerCore = require('./core');
const registerOperations = require('./operations');
const registerAppointments = require('./appointments');
const registerUsers = require('./users');
const registerPlatform = require('./platform');

module.exports = app => {
  registerPlatform(app);
  registerCore(app);
  registerOperations(app);
  registerAppointments(app);
  registerUsers(app);
};
