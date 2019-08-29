'use strict'
const assert = require('assert')
const { it } = require('mocha')
const main = require('../')
const parse = require('./parse')
const tcompare = require('tcompare')

const test = it

const strict = (x, y) => assert.ok(tcompare.strict(x, y).match)

test('basic keyed union', done => {
  const schema = `
  type Test union {
    | String "name"
    | String "alt"
  } representation keyed
  `
  const classes = main(parse(schema))
  const hw = { name: 'hello world' }
  const t = new classes.Test(hw)

  strict(t.encode(), hw)

  const val = classes.Test.from(hw).encode()
  strict(t.encode(), val)
  done()
})