import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GroupDefinitions } from './groups';

// Native set_expression.py's implication and user-type disjoint rules.
const defs=new GroupDefinitions([1,2,3,4],[[2,1]], [1,3], [['internal',1],['manager',2],['portal',3],['extra',4]]);
test('implication, disjoint groups and negation simplify view access',()=>{
  assert.ok(defs.parse('manager').le(defs.parse('internal')));
  assert.ok(defs.parse('manager').and(defs.parse('portal')).empty);
  assert.ok(defs.parse('manager').and(defs.parse('!internal')).empty);
  assert.ok(defs.parse('internal,!extra').or(defs.parse('internal,extra').and(defs.parse('internal')).and(defs.parse('extra'))).le(defs.parse('internal')));
  assert.ok(defs.parse('extra').or(defs.parse('!extra')).universal);
});
test('missing-field group factoring retains the required extra group',()=>{
  const access=defs.parse('internal'),needed=access.and(defs.parse('extra'));
  const factored=needed.invertIntersect(access);
  assert.ok(factored);
  assert.ok(factored.and(access).le(needed));
  assert.equal(factored.matches(new Set([1])),false);
  assert.equal(factored.matches(new Set([1,4])),true);
});
test('unknown group references never match an existing user',()=>{
  assert.equal(defs.parse('missing').matches(new Set([1,2])),false);
  assert.equal(defs.parse('!missing').matches(new Set([1,2])),true);
  assert.equal(defs.universe.matches(new Set()),false);
});
