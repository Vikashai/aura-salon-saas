'use strict';
const registerCore = require('./core');
const registerOperations = require('./operations');
const registerAppointments = require('./appointments');
const registerUsers = require('./users');

module.exports = app => {
  registerCore(app);
  registerOperations(app);
  registerAppointments(app);
  registerUsers(app);
};
