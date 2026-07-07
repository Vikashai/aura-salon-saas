'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { can,permissionsFor }=require('../src/access');
test('owner has complete access',()=>assert.equal(can({role:'owner'},'users.manage'),true));
test('receptionist can bill but cannot manage settings',()=>{assert.equal(can({role:'receptionist'},'billing.manage'),true);assert.equal(can({role:'receptionist'},'settings.view'),false)});
test('manage permission also grants module visibility',()=>assert.equal(can({role:'custom',permissions:'["customers.manage"]'},'customers.view'),true));
test('custom permissions are parsed safely',()=>assert.deepEqual([...permissionsFor({role:'custom',permissions:'["reports.view"]'})],['reports.view']));
