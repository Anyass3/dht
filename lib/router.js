const c = require('compact-encoding')
const Cache = require('xache')
const safetyCatch = require('safety-catch')
const { handshake, holepunch } = require('./messages')
const { COMMANDS } = require('./constants')

const FROM_CLIENT = 0
const FROM_SERVER = 1
const FROM_RELAY = 2
const FROM_SECOND_RELAY = 3
const REPLY = 4

// TODO: While the current design is very trustless in regards to clients/servers trusting the DHT,
// we should add a bunch of rate limits everywhere, especially including here to avoid bad users
// using a DHT node to relay traffic indiscriminately using the connect/holepunch messages.
// That's mostly from an abuse POV as none of the messsages do amplication.

module.exports = class HolepunchRouter {
  constructor (dht, opts) {
    this.dht = dht
    this.servers = new Map()
    this.forwards = new Cache(opts)
  }

  set (target, state) {
    const k = toString(target)
    // we need this to avoid servers getting gc'ed
    // potentially better to reimpl the cache here or add this func to the cache?
    if (state.onpeerhandshake) {
      this.servers.set(k, state)
      this.forwards.delete(k)
    } else {
      this.forwards.set(k, state)
      this.servers.delete(k)
    }
  }

  get (target) {
    const k = toString(target)
    return this.servers.get(k) || this.forwards.get(k)
  }

  delete (target) {
    const k = toString(target)
    this.servers.delete(k)
    this.forwards.delete(k)
  }

  async peerHandshake (target, { noise, peerAddress, relayAddress }, to) {
    const dht = this.dht
    const requestValue = c.encode(handshake, {
      mode: FROM_CLIENT,
      noise,
      peerAddress,
      relayAddress
    })

    const res = await dht.request({ command: COMMANDS.PEER_HANDSHAKE, target, value: requestValue }, to)

    const hs = decode(handshake, res.value)
    if (!hs || hs.mode !== REPLY || (to.host !== res.from.host || to.port !== res.from.port) || !hs.noise) {
      throw new Error('Bad handshake reply')
    }

    return {
      noise: hs.noise,
      relayed: !!hs.peerAddress,
      serverAddress: hs.peerAddress || to,
      clientAddress: res.to
    }
  }

  async onpeerhandshake (req) {
    const hs = req.value && decode(handshake, req.value)
    if (!hs) return

    const { mode, noise, peerAddress, relayAddress } = hs

    const state = req.target && this.get(req.target)
    const isServer = !!(state && state.onpeerhandshake)
    const relay = state && state.relay

    if (isServer) {
      let reply = null
      try {
        reply = noise && await state.onpeerhandshake({ noise, peerAddress }, req)
      } catch (e) {
        safetyCatch(e)
        return
      }
      if (!reply || !reply.noise) return
      const opts = { socket: reply.socket, closerNodes: false, token: false }

      switch (mode) {
        case FROM_CLIENT: {
          req.reply(c.encode(handshake, { mode: REPLY, noise: reply.noise, peerAddress: null }), opts)
          return
        }
        case FROM_RELAY: {
          req.relay(c.encode(handshake, { mode: FROM_SERVER, noise: reply.noise, peerAddress }), req.from, opts)
          return
        }
        case FROM_SECOND_RELAY: {
          if (!relayAddress) return
          req.relay(c.encode(handshake, { mode: FROM_SERVER, noise: reply.noise, peerAddress }), relayAddress, opts)
          return // eslint-disable-line
        }
      }
    } else {
      switch (mode) {
        case FROM_CLIENT: {
          // TODO: if no relay is known route closer to the target instead of timing out
          if (!noise) return
          if (!relay && !relayAddress) { // help the user route
            req.reply(null, { token: false, closerNodes: true })
            return
          }
          req.relay(c.encode(handshake, { mode: FROM_RELAY, noise, peerAddress: req.from, relayAddress: null }), relayAddress || relay)
          return
        }
        case FROM_RELAY: {
          if (!relay || !noise) return
          req.relay(c.encode(handshake, { mode: FROM_SECOND_RELAY, noise, peerAddress, relayAddress: req.from }), relay)
          return
        }
        case FROM_SERVER: {
          if (!peerAddress || !noise) return
          req.reply(c.encode(handshake, { mode: REPLY, noise, peerAddress: req.from, relayAddress: null }), { to: peerAddress, closerNodes: false, token: false })
          return // eslint-disable-line
        }
      }
    }
  }

  async peerHolepunch (target, { id, payload, peerAddress, socket }, to) {
    const dht = this.dht
    const requestValue = c.encode(holepunch, {
      mode: FROM_CLIENT,
      id,
      payload,
      peerAddress
    })

    const res = await dht.request({ command: COMMANDS.PEER_HOLEPUNCH, target, value: requestValue }, to, { socket })

    const hp = decode(holepunch, res.value)
    if (!hp || hp.mode !== REPLY || (to.host !== res.from.host || to.port !== res.from.port)) {
      throw new Error('Bad holepunch reply')
    }

    return {
      from: res.from,
      to: res.to,
      payload: hp.payload,
      peerAddress: hp.peerAddress
    }
  }

  async onpeerholepunch (req) {
    const hp = req.value && decode(holepunch, req.value)
    if (!hp) return

    const { mode, id, payload, peerAddress } = hp

    const state = req.target && this.get(req.target)
    const isServer = !!(state && state.onpeerholepunch)
    const relay = state && state.relay

    switch (mode) {
      case FROM_CLIENT: {
        if (!peerAddress && !relay) return
        req.relay(c.encode(holepunch, { mode: FROM_RELAY, id, payload, peerAddress: req.from }), peerAddress || relay)
        return
      }
      case FROM_RELAY: {
        if (!isServer || !peerAddress) return
        let reply = null
        try {
          reply = await state.onpeerholepunch({ id, payload, peerAddress }, req)
        } catch (e) {
          safetyCatch(e)
          return
        }
        if (!reply) return
        const opts = { socket: reply.socket, closerNodes: false, token: false }
        req.relay(c.encode(holepunch, { mode: FROM_SERVER, id: 0, payload: reply.payload, peerAddress }), req.from, opts)
        return
      }
      case FROM_SERVER: {
        req.reply(c.encode(holepunch, { mode: REPLY, id, payload, peerAddress: req.from }), { to: peerAddress, closerNodes: false, token: false })
        return // eslint-disable-line
      }
    }
  }
}

function decode (enc, val) {
  try {
    return c.decode(enc, val)
  } catch {
    return null
  }
}

function toString (t) {
  return typeof t === 'string' ? t : t.toString('hex')
}
