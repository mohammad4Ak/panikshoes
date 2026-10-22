const fs = require('node:fs')
const path = require('node:path')
const { transformSync } = require('esbuild')
const customerContact = { exports: {} }
Function('module', transformSync(fs.readFileSync(path.join(__dirname, '../../src/lib/customer-contact.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code)(customerContact)
module.exports = customerContact.exports
