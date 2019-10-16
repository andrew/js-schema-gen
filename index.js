'use strict'
const CID = require('cids')
const bytes = require('bytesish')
const Block = require('@ipld/block')

const isInt = n => n % 1 === 0

const _create = (CLS, value, schema) => {
  if (!CLS) throw new Error('Missing Class')
  if (CLS.encoder) return CLS.encoder(value)
  else return new CLS(value, schema)
}

const create = (parsed, opts = {}) => {
  const classes = {}
  const classSet = new Set()

  if (opts.advanced) {
    for (const [key, impl] of Object.entries(opts.advanced)) {
      if (impl.schema) {
        const s = impl.schema
        const advanced = s.opts && s.opts.advanced ? s.opts.advanced : {}
        const _opts = Object.assign({}, opts, { advanced })
        impl.schema = create(impl.schema, _opts)[key]
      }
    }
  }

  class Advanced {
    constructor (value, schema) {
      // TODO: schema validation
      this.value = value
      this.schema = schema
      this.opts = opts
      for (const [prop, method] of Object.entries(schema.implementation)) {
        if (prop === 'schema') {
          this.parsed = method.encoder(value)
        } else {
          this[prop] = (...args) => method(this, ...args)
        }
      }
    }

    encoder (schema) {
      // eslint-disable-next-line new-cap
      return obj => new this.cls(obj, schema)
    }

    decoder (schema) {
      // eslint-disable-next-line new-cap
      return obj => new this.cls(obj, schema)
    }

    encode () {
      return this.parsed.encode()
    }
  }

  class Remaining {
    constructor (node, remaining) {
      this.node = node
      this.remaining = remaining
    }
  }

  class Node {
    constructor (value, schema) {
      if (!value.isNode) {
        this.parsed = this.validate(value)
        this.value = value
      } else {
        this.parsed = value
        Object.defineProperty(this, 'value', { get: () => parsed.encode() })
      }
      this.valid = Boolean(this.parsed)
      this.schema = schema
    }

    get isNode () {
      return true
    }

    async get (path) {
      const result = this.resolve(path.split('/').filter(x => x))
      if (result instanceof Remaining) {
        if (opts.getBlock) {
          const link = result.node
          const block = await opts.getBlock(link.value)
          const expected = link.schema.type.expectedType
          const node = _create(classes[expected], block.decode(), this.schema)
          return node.get(result.remaining.join('/'))
        } else {
          throw new Error('get() cannot resolve multi-block paths without opts.getBlock.')
        }
      }
      if (typeof result === 'object' && !result.isKind) {
        throw new Error('get() must resolve to a primitive kind. Use .resolve() instead.')
      }
      return result.value ? result.value : result
    }

    block (codec = 'dag-json') {
      return Block.encoder(this.encode(), codec)
    }
  }

  /* The cast() function is useful at this stage of development
   * but it should be seen as an unnecessary performance bottleneck
   * wherever it is used.
   * Recursively casting Kind classes around values isn't strictly necessary
   * because no schema types can be defined within these containers. The only
   * reason to do this is to get a consistent API when resolving through
   * nodes and it's always going to be faster to branch the logic for
   * these rather than cast a Kind instance around them.
   */
  const cast = o => {
    if (typeof o === 'undefined') throw new Error('Cannot cast undefined')
    if (typeof o === 'boolean') return new classes.Boolean(o)
    if (typeof o === 'string') return new classes.String(o)
    if (o === null) return new classes.Null(null)
    if (typeof o === 'number') {
      if (isInt(o)) return new classes.Int(o)
      else return new classes.Float(o)
    }
    if (typeof o === 'object') {
      if (o.isNode) return o
      if (Array.isArray(o)) return new classes.List(o)
      // TODO: replace Buffer.isBuffer with bytesish to reduce bundle size
      if (Buffer.isBuffer(o)) return new classes.Bytes(o)
      if (CID.isCID(o)) return new classes.Link(o)
      return new classes.Map(o)
    }
    throw new Error('Unsupported type')
  }

  class Kind extends Node {
    constructor (value, schema) {
      if (typeof value === 'undefined') throw new Error('undefined value')
      super(value, schema)
      this.isKind = true
      if (value instanceof this.constructor) {
        this.parsed = value
        this.value = value.encode()
      } else {
        if (!this.valid) throw new Error('Validation error')
        this.parsed = value
      }
    }

    resolve (arr) {
      if (arr.length) throw new Error('Cannot traverse path into this object')
      return this
    }

    encode () {
      return this.value.encode ? this.value.encode() : this.value
    }
  }
  classes.Int = class Int extends Kind {
    validate (value) {
      return Number.isInteger(value)
    }
  }
  classes.Float = class Float extends Kind {
    validate (value) {
      return typeof value === 'number' && !Number.isInteger(value)
    }
  }
  classes.String = class String extends Kind {
    validate (value) {
      return typeof value === 'string'
    }
  }
  classes.Null = class Null extends Kind {
    validate (value) {
      return value === null
    }
  }
  classes.Boolean = class Boolean extends Kind {
    validate (value) {
      return typeof value === 'boolean'
    }
  }
  classes.Bytes = class Bytes extends Kind {
    validate (value) {
      return bytes.native(value)
    }

    encode () {
      return this.parsed
    }
  }
  classes.Map = class Map extends Kind {
    validate (value) {
      return typeof value === 'object'
    }

    keys () {
      return Object.keys(this.value)
    }

    resolve (arr) {
      if (!arr.length) return this
      const key = arr.shift()
      return cast(this.parsed[key]).resolve(arr)
    }
  }
  classes.List = class List extends classes.Map {
    validate (value) {
      return Array.isArray(value)
    }
  }
  classes.Link = class Link extends Kind {
    validate (value) {
      return CID.isCID(value)
    }

    resolve (arr) {
      return new Remaining(this, arr)
    }
  }

  class Struct extends Node {
    validate (value) {
      const parsed = {}
      if (typeof value !== 'object') throw new Error('Invalid type')
      for (const [k, def] of Object.entries(this.def.fields)) {
        if (!def.optional && typeof value[k] === 'undefined') {
          throw new Error(`Missing required field "${k}"`)
        }
        if (typeof value[k] !== 'undefined') {
          if (value[k] === null) {
            if (def.nullable || def.type === 'Null') parsed[k] = null
            else throw new Error('Field is not nullable')
          } else {
            if (value[k].constructor && classSet.has(value[k].constructor)) {
              parsed[k] = value[k]
            } else {
              /* eslint-disable max-depth */
              if (def.type.kind) {
                const kind = def.type.kind
                if (kind === 'link') {
                  parsed[k] = _create(classes.Link, value[k], def)
                } else {
                  throw new Error('schema error')
                }
              } else {
                const CLS = classes[def.type]
                parsed[k] = _create(CLS, value[k], def)
              }
            }
          }
        }
      }
      return parsed
    }

    resolve (arr) {
      if (!arr.length) return this
      return this.parsed[arr.shift()].resolve(arr)
    }

    keys () {
      return Object.keys(this.parsed)
    }

    encode () {
      const encoded = {}
      for (const [k, v] of Object.entries(this.value)) {
        if (typeof this.parsed[k] === 'undefined') encoded[k] = v.encode ? v.encode() : v
        else if (this.parsed[k] === null) encoded[k] = null
        else encoded[k] = this.parsed[k].encode()
      }
      return encoded
    }

    encoder (def) {
      return obj => {
        if (typeof obj !== 'object') throw new Error('Unsupported struct serialization')
        // TODO: handle any renames

        // eslint-disable-next-line new-cap
        return new this.cls(obj, def)
      }
    }
  }

  class Union extends Node {
    validate (value) {
      const parsed = {}
      if (typeof value !== 'object') throw new Error('Invalid encoding')
      const keys = Object.keys(value)
      if (keys.length !== 1) throw new Error('Map must only have one key')

      if (this.def.representation.keyed) {
        const key = keys[0]
        const val = value[key]
        const className = this.def.representation.keyed[key]
        parsed[key] = _create(classes[className], val)
      }
      return parsed
    }

    resolve (arr) {
      const value = Object.values(this.parsed)[0]
      return value.resolve(arr)
    }

    encoder (def) {
      const rep = def.representation
      return obj => {
        // should we throw if there is more than one key?
        if (typeof obj !== 'object') throw new Error('Unsupported union serialization')
        if (rep.keyed) {
          for (const [key, className] of Object.entries(rep.keyed)) {
            if (obj[key]) {
              const parsed = { }
              if (typeof className === 'string') {
                parsed[key] = _create(classes[className], obj[key])
              } else {
                if (className.kind === 'link') {
                  return _create(classes.Link, obj[key], className)
                } else {
                  throw new Error('Unsupported inline type')
                }
              }
              // eslint-disable-next-line new-cap
              return new this.cls(parsed, rep)
            }
          }
          const keys = Object.keys(rep.keyed)
          throw new Error('Keyed union must have one of the following keys: ' + keys.join(', '))
        } else {
          throw new Error('Unsupported: only have support for keyed unions')
        }
      }
    }

    encode () {
      const [key, value] = Object.keys(this.parsed).map(k => ([k, this.parsed[k]]))[0]
      const ret = {}
      ret[key] = value.encode()
      return ret
    }
  }

  classes.Struct = Struct
  classes.Union = Union

  // Enum

  const kindMap = {
    struct: classes.Struct,
    union: classes.Union
  }

  const _eval = name => `
    const me = class ${name} extends baseClass {
      get def () {
        return def
      }
      get cls () {
        return me
      }
    }
    me.encoder = me.prototype.encoder(def)

    // this will change once aliasing is supported but
    // right now the validation on both sides is identical.
    me.decoder = me.encoder
    delete me.prototype.encoder
    return me
  `
  const result = {}
  for (const [key, def] of Object.entries(parsed.types)) {
    // eslint-disable-next-line no-new-func
    const fn = new Function('baseClass', 'def', _eval(key))
    let baseClass
    if (def.representation && def.representation.advanced) {
      const className = def.representation.advanced
      if (!opts.advanced || !opts.advanced[className]) {
        throw new Error(`This schema needs and implementation of ${className}`)
      }
      def.implementation = opts.advanced[className]
      baseClass = Advanced
    } else {
      baseClass = kindMap[def.kind]
    }
    const _class = fn(baseClass, def)
    classes[key] = _class
    result[key] = _class
  }
  Object.values(classes).forEach(cls => classSet.add(cls))

  return result
}

module.exports = create
