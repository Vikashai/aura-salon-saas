'use strict';
const registerCore = require('./core');
const registerOperations = require('./operations');
const registerAppointments = require('./appointments');
const registerUsers = require('./users');
const registerPlatform = require('./platform');
const registerWebhooks = require('./webhooks');

module.exports = app => {
  registerWebhooks(app);
  registerPlatform(app);
  registerCore(app);
  registerOperations(app);
  registerAppointments(app);
  registerUsers(app);
};
