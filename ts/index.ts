/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore
import { utils } from 'libp2p-pubsub'
import { MessageCache } from './messageCache'
import {
  RPCCodec,
  RPC, Message, InMessage,
  ControlMessage, ControlIHave, ControlGraft, ControlIWant, ControlPrune
} from './message'
import * as constants from './constants'
import { Heartbeat } from './heartbeat'
import { getGossipPeers } from './getGossipPeers'
import { createGossipRpc } from './utils'
import { Peer, Registrar } from './peer'
// @ts-ignore
import TimeCache = require('time-cache')
import PeerId = require('peer-id')
import BasicPubsub = require('./pubsub')

interface GossipOptions {
  emitSelf: boolean
  gossipIncoming: boolean
  fallbackToFloodsub: boolean
  msgIdFn: (msg: Message) => string
  messageCache: MessageCache
}

class Gossipsub extends BasicPubsub {
  peers: Map<string, Peer>
  topics: Map<string, Set<Peer>>
  mesh: Map<string, Set<Peer>>
  fanout: Map<string, Set<Peer>>
  lastpub: Map<string, number>
  gossip: Map<Peer, ControlIHave[]>
  control: Map<Peer, ControlMessage>
  _options: GossipOptions

  public static multicodec: string = constants.GossipsubID

  /**
   * @param {PeerId} peerId instance of the peer's PeerId
   * @param {Object} registrar
   * @param {function} registrar.handle
   * @param {function} registrar.register
   * @param {function} registrar.unregister
   * @param {Object} [options]
   * @param {bool} [options.emitSelf] if publish should emit to self, if subscribed, defaults to false
   * @param {bool} [options.gossipIncoming] if incoming messages on a subscribed topic should be automatically gossiped, defaults to true
   * @param {bool} [options.fallbackToFloodsub] if dial should fallback to floodsub, defaults to true
   * @param {function} [options.msgIdFn] override the default message id function
   * @param {Object} [options.messageCache] override the default MessageCache
   * @constructor
   */
  constructor (peerId: PeerId, registrar: Registrar, options: Partial<GossipOptions> = {}) {
    const multicodecs = [constants.GossipsubID]
    const _options = {
      gossipIncoming: true,
      fallbackToFloodsub: true,
      ...options
    }

    // Also wants to get notified of peers connected using floodsub
    if (_options.fallbackToFloodsub) {
      multicodecs.push(constants.FloodSubID)
    }

    super({
      debugName: 'libp2p:gossipsub',
      multicodecs,
      peerId,
      registrar,
      options: _options as GossipOptions
    })

    /**
     * Cache of seen messages
     *
     * @type {TimeCache}
     */
    this.seenCache = new TimeCache()

    /**
     * Map of topic meshes
     *
     * @type {Map<string, Set<Peer>>}
     */
    this.mesh = new Map()

    /**
     * Map of topics to set of peers. These mesh peers are the ones to which we are publishing without a topic membership
     *
     * @type {Map<string, Set<Peer>>}
     */
    this.fanout = new Map()

    /**
     * Map of last publish time for fanout topics
     *
     * @type {Map<string, Number>}
     */
    this.lastpub = new Map()

    /**
     * Map of pending messages to gossip
     *
     * @type {Map<Peer, Array<ControlIHave object>> }
     */
    this.gossip = new Map()

    /**
     * Map of control messages
     *
     * @type {Map<Peer, ControlMessage object>}
     */
    this.control = new Map()

    /**
     * Use the overriden mesgIdFn or the default one.
     */
    this._msgIdFn = options.msgIdFn || this.defaultMsgIdFn

    /**
     * A message cache that contains the messages for last few hearbeat ticks
     *
     */
    this.messageCache = options.messageCache || new MessageCache(constants.GossipsubHistoryGossip, constants.GossipsubHistoryLength, this._msgIdFn)

    /**
     * A heartbeat timer that maintains the mesh
     */
    this.heartbeat = new Heartbeat(this)
  }

  /**
   * Removes a peer from the router
   * @override
   * @param {Peer} peer
   * @returns {Peer}
   */
  _removePeer (peer: Peer): Peer {
    super._removePeer(peer)

    // Remove this peer from the mesh
    // eslint-disable-next-line no-unused-vars
    for (const peers of this.mesh.values()) {
      peers.delete(peer)
    }

    // Remove this peer from the fanout
    // eslint-disable-next-line no-unused-vars
    for (const peers of this.fanout.values()) {
      peers.delete(peer)
    }

    // Remove from gossip mapping
    this.gossip.delete(peer)
    // Remove from control mapping
    this.control.delete(peer)

    return peer
  }

  /**
   * Handles an rpc request from a peer
   *
   * @override
   * @param {String} idB58Str
   * @param {Peer} peer
   * @param {RPC} rpc
   * @returns {void}
   */
  _processRpc (idB58Str: string, peer: Peer, rpc: RPC): void {
    super._processRpc(idB58Str, peer, rpc)
    if (rpc.control) {
      this._processRpcControlMessage(peer, rpc.control)
    }
  }

  /**
   * Handles an rpc control message from a peer
   * @param {Peer} peer
   * @param {ControlMessage} controlMsg
   * @returns {void}
   */
  _processRpcControlMessage (peer: Peer, controlMsg: ControlMessage): void {
    if (!controlMsg) {
      return
    }

    const iwant = this._handleIHave(peer, controlMsg.ihave)
    const ihave = this._handleIWant(peer, controlMsg.iwant)
    const prune = this._handleGraft(peer, controlMsg.graft)
    this._handlePrune(peer, controlMsg.prune)

    if (!iwant || !ihave || !prune) {
      return
    }

    const outRpc = createGossipRpc(ihave, { iwant: [iwant], prune })
    this._sendRpc(peer, outRpc)
  }

  /**
   * Process incoming message,
   * emitting locally and forwarding on to relevant floodsub and gossipsub peers
   * @override
   * @param {Peer} peer
   * @param {Message} msg
   */
  _processRpcMessage (peer: Peer, msg: InMessage): void {
    const msgID = this.getMsgId(msg)

    // Ignore if we've already seen the message
    if (this.seenCache.has(msgID)) {
      return
    }
    this.seenCache.put(msgID)

    super._processRpcMessage(peer, msg)
    const topics = msg.topicIDs

    // If options.gossipIncoming is false, do NOT emit incoming messages to peers
    if (!this._options.gossipIncoming) {
      return
    }

    // Emit to floodsub peers
    this.peers.forEach((peer) => {
      if (peer.protocols.includes(constants.FloodSubID) &&
        peer.id.toB58String() !== msg.from &&
        utils.anyMatch(peer.topics, topics) &&
        peer.isWritable
      ) {
        peer.sendMessages(utils.normalizeOutRpcMessages([msg]))
        this.log('publish msg on topics - floodsub', topics, peer.id.toB58String())
      }
    })

    // Emit to peers in the mesh
    topics.forEach((topic) => {
      const meshPeers = this.mesh.get(topic)
      if (!meshPeers) {
        return
      }
      meshPeers.forEach((peer) => {
        if (!peer.isWritable || peer.id.toB58String() === msg.from) {
          return
        }
        peer.sendMessages(utils.normalizeOutRpcMessages([msg]))
        this.log('publish msg on topic - meshsub', topic, peer.id.toB58String())
      })
    })
  }

  /**
   * Handles IHAVE messages
   * @param {Peer} peer
   * @param {Array<ControlIHave>} ihave
   * @returns {ControlIWant}
   */
  _handleIHave (peer: Peer, ihave: ControlIHave[]): ControlIWant | undefined {
    const iwant = new Set<string>()

    ihave.forEach(({ topicID, messageIDs }) => {
      if (!topicID || !this.mesh.has(topicID)) {
        return
      }

      messageIDs.forEach((msgID) => {
        if (this.seenCache.has(msgID)) {
          return
        }
        iwant.add(msgID)
      })
    })

    if (!iwant.size) {
      return
    }

    this.log('IHAVE: Asking for %d messages from %s', iwant.size, peer.id.toB58String())

    return {
      messageIDs: Array.from(iwant)
    }
  }

  /**
   * Handles IWANT messages
   * Returns messages to send back to peer
   * @param {Peer} peer
   * @param {Array<ControlIWant>} iwant
   * @returns {Array<Message>}
   */
  _handleIWant (peer: Peer, iwant: ControlIWant[]): Message[] | undefined {
    // @type {Map<string, Message>}
    const ihave = new Map<string, Message>()

    iwant.forEach(({ messageIDs }) => {
      messageIDs.forEach((msgID) => {
        const msg = this.messageCache.get(msgID)
        if (msg) {
          ihave.set(msgID, msg)
        }
      })
    })

    if (!ihave.size) {
      return
    }

    this.log('IWANT: Sending %d messages to %s', ihave.size, peer.id.toB58String())

    return Array.from(ihave.values())
  }

  /**
   * Handles Graft messages
   * @param {Peer} peer
   * @param {Array<ControlGraft>} graft
   * @return {Array<ControlPrune>}
   */
  _handleGraft (peer: Peer, graft: ControlGraft[]): ControlPrune[] | undefined {
    const prune: string[] = []

    graft.forEach(({ topicID }) => {
      if (!topicID) {
        return
      }
      const peers = this.mesh.get(topicID)
      if (!peers) {
        prune.push(topicID)
      } else {
        this.log('GRAFT: Add mesh link from %s in %s', peer.id.toB58String(), topicID)
        peers.add(peer)
        peer.topics.add(topicID)
        this.mesh.set(topicID, peers)
      }
    })

    if (!prune.length) {
      return
    }

    const buildCtrlPruneMsg = (topic: string) => {
      return {
        topicID: topic
      }
    }

    return prune.map(buildCtrlPruneMsg)
  }

  /**
   * Handles Prune messages
   * @param {Peer} peer
   * @param {Array<ControlPrune>} prune
   * @returns {void}
   */
  _handlePrune (peer: Peer, prune: ControlPrune[]): void {
    prune.forEach(({ topicID }) => {
      if (!topicID) {
        return
      }
      const peers = this.mesh.get(topicID)
      if (peers) {
        this.log('PRUNE: Remove mesh link to %s in %s', peer.id.toB58String(), topicID)
        peers.delete(peer)
        peer.topics.delete(topicID)
      }
    })
  }

  /**
   * Mounts the gossipsub protocol onto the libp2p node and sends our
   * our subscriptions to every peer connected
   * @override
   * @returns {Promise}
   */
  async start (): Promise<void> {
    await super.start()
    this.heartbeat.start()
  }

  /**
   * Unmounts the gossipsub protocol and shuts down every connection
   * @override
   * @returns {Promise}
   */
  async stop (): Promise<void> {
    await super.stop()
    this.heartbeat.stop()

    this.mesh = new Map()
    this.fanout = new Map()
    this.lastpub = new Map()
    this.gossip = new Map()
    this.control = new Map()
  }

  /**
   * Subscribes to topics
   *
   * @override
   * @param {Array<string>} topics
   * @returns {void}
   */
  _subscribe (topics: string[]): void {
    super._subscribe(topics)
    this.join(topics)
  }

  /**
   * Unsubscribes to topics
   *
   * @override
   * @param {Array<string>} topics
   * @returns {void}
   */
  _unsubscribe (topics: string[]): void {
    super._unsubscribe(topics)
    this.leave(topics)
  }

  /**
   * Join topics
   * @param {Array<string>|string} topics
   * @returns {void}
   */
  join (topics: string[] | string): void {
    if (!this.started) {
      throw new Error('Gossipsub has not started')
    }
    topics = utils.ensureArray(topics)

    this.log('JOIN %s', topics)

    ;(topics as string[]).forEach((topic) => {
      // Send GRAFT to mesh peers
      const fanoutPeers = this.fanout.get(topic)
      if (fanoutPeers) {
        this.mesh.set(topic, fanoutPeers)
        this.fanout.delete(topic)
        this.lastpub.delete(topic)
      } else {
        const peers = getGossipPeers(this, topic, constants.GossipsubD)
        this.mesh.set(topic, peers)
      }
      this.mesh.get(topic)!.forEach((peer) => {
        this.log('JOIN: Add mesh link to %s in %s', peer.id.toB58String(), topic)
        this._sendGraft(peer, topic)
      })
    })
  }

  /**
   * Leave topics
   * @param {Array<string>|string} topics
   * @returns {void}
   */
  leave (topics: string[] | string): void {
    topics = utils.ensureArray(topics)

    this.log('LEAVE %s', topics)

    ;(topics as string[]).forEach((topic) => {
      // Send PRUNE to mesh peers
      const meshPeers = this.mesh.get(topic)
      if (meshPeers) {
        meshPeers.forEach((peer) => {
          this.log('LEAVE: Remove mesh link to %s in %s', peer.id.toB58String(), topic)
          this._sendPrune(peer, topic)
        })
        this.mesh.delete(topic)
      }
    })
  }

  /**
   * Override the default implementation in BasicPubSub.
   * If we don't provide msgIdFn in constructor option, it's the same.
   * @override
   * @param {Message} msg the message object
   * @returns {string} message id as string
   */
  getMsgId (msg: InMessage): string {
    return this._msgIdFn(msg)
  }

  /**
   * Publish messages
   *
   * Note: this function assumes all messages are well-formed RPC objects
   * @override
   * @param {Array<Message>} msgs
   * @returns {void}
   */
  _publish (msgs: InMessage[]): void {
    msgs.forEach((msgObj) => {
      const msgID = this.getMsgId(msgObj)
      // put in seen cache
      this.seenCache.put(msgID)

      this.messageCache.put(msgObj)
      const tosend = new Set<Peer>()
      msgObj.topicIDs.forEach((topic) => {
        const peersInTopic = this.topics.get(topic)
        if (!peersInTopic) {
          return
        }

        // floodsub peers
        peersInTopic.forEach((peer) => {
          if (peer.protocols.includes(constants.FloodSubID)) {
            tosend.add(peer)
          }
        })

        // Gossipsub peers handling
        let meshPeers = this.mesh.get(topic)
        if (!meshPeers || !meshPeers.size) {
          // We are not in the mesh for topic, use fanout peers
          meshPeers = this.fanout.get(topic)
          if (!meshPeers) {
            // If we are not in the fanout, then pick any peers in topic
            const peers = getGossipPeers(this, topic, constants.GossipsubD)

            if (peers.size > 0) {
              meshPeers = peers
              this.fanout.set(topic, peers)
            } else {
              meshPeers = new Set()
            }
          }
          // Store the latest publishing time
          this.lastpub.set(topic, this._now())
        }

        meshPeers!.forEach((peer) => {
          tosend.add(peer)
        })
      })
      // Publish messages to peers
      tosend.forEach((peer) => {
        if (peer.id.toB58String() === msgObj.from) {
          return
        }
        this._sendRpc(peer, createGossipRpc([utils.normalizeOutRpcMessage(msgObj)]))
      })
    })
  }

  /**
   * Sends a GRAFT message to a peer
   * @param {Peer} peer
   * @param {String} topic
   * @returns {void}
   */
  _sendGraft (peer: Peer, topic: string): void {
    const graft = [{
      topicID: topic
    }]

    const out = createGossipRpc([], { graft })
    this._sendRpc(peer, out)
  }

  /**
   * Sends a PRUNE message to a peer
   * @param {Peer} peer
   * @param {String} topic
   * @returns {void}
   */
  _sendPrune (peer: Peer, topic: string): void {
    const prune = [{
      topicID: topic
    }]

    const out = createGossipRpc([], { prune })
    this._sendRpc(peer, out)
  }

  _sendRpc (peer: Peer, outRpc: RPC): void {
    if (!peer || !peer.isWritable) {
      return
    }

    // piggyback control message retries
    const ctrl = this.control.get(peer)
    if (ctrl) {
      this._piggybackControl(peer, outRpc, ctrl)
      this.control.delete(peer)
    }

    // piggyback gossip
    const ihave = this.gossip.get(peer)
    if (ihave) {
      this._piggybackGossip(peer, outRpc, ihave)
      this.gossip.delete(peer)
    }

    peer.write(RPCCodec.encode(outRpc))
  }

  _piggybackControl (peer: Peer, outRpc: RPC, ctrl: ControlMessage): void {
    const tograft = (ctrl.graft || [])
      .filter(({ topicID }) => (topicID && this.mesh.get(topicID) || new Set()).has(peer))
    const toprune = (ctrl.prune || [])
      .filter(({ topicID }) => !(topicID && this.mesh.get(topicID) || new Set()).has(peer))

    if (!tograft.length && !toprune.length) {
      return
    }

    if (outRpc.control) {
      outRpc.control.graft = outRpc.control.graft.concat(tograft)
      outRpc.control.prune = outRpc.control.prune.concat(toprune)
    } else {
      outRpc.control = { ihave: [], iwant: [], graft: tograft, prune: toprune }
    }
  }

  _piggybackGossip (peer: Peer, outRpc: RPC, ihave: ControlIHave[]): void {
    if (!outRpc.control) {
      outRpc.control = { ihave: [], iwant: [], graft: [], prune: [] }
    }
    outRpc.control.ihave = ihave
  }

  /**
   * Send graft and prune messages
   * @param {Map<Peer, Array<String>>} tograft
   * @param {Map<Peer, Array<String>>} toprune
   */
  _sendGraftPrune (tograft: Map<Peer, string[]>, toprune: Map<Peer, string[]>): void {
    for (const [p, topics] of tograft) {
      const graft = topics.map((topicID) => ({ topicID }))
      let prune: ControlPrune[] = []
      // If a peer also has prunes, process them now
      const pruneMsg = toprune.get(p)
      if (pruneMsg) {
        prune = pruneMsg.map((topicID) => ({ topicID }))
        toprune.delete(p)
      }

      const outRpc = createGossipRpc([], { graft, prune })
      this._sendRpc(p, outRpc)
    }
    for (const [p, topics] of toprune) {
      const prune = topics.map((topicID) => ({ topicID }))
      const outRpc = createGossipRpc([], { prune })
      this._sendRpc(p, outRpc)
    }
  }

  /**
   * Emits gossip to peers in a particular topic
   * @param {String} topic
   * @param {Set<Peer>} peers - peers to exclude
   * @returns {void}
   */
  _emitGossip (topic: string, peers: Set<Peer>): void {
    const messageIDs = this.messageCache.getGossipIDs(topic)
    if (!messageIDs.length) {
      return
    }

    const gossipSubPeers = getGossipPeers(this, topic, constants.GossipsubD)
    gossipSubPeers.forEach((peer) => {
      // skip mesh peers
      if (!peers.has(peer)) {
        this._pushGossip(peer, {
          topicID: topic,
          messageIDs: messageIDs
        })
      }
    })
  }

  /**
   * Flush gossip and control messages
   */
  _flush (): void {
    // send gossip first, which will also piggyback control
    for (const [peer, ihave] of this.gossip.entries()) {
      this.gossip.delete(peer)
      const out = createGossipRpc([], { ihave })
      this._sendRpc(peer, out)
    }
    // send the remaining control messages
    for (const [peer, control] of this.control.entries()) {
      this.control.delete(peer)
      const out = createGossipRpc([], { graft: control.graft, prune: control.prune })
      this._sendRpc(peer, out)
    }
  }

  /**
   * Adds new IHAVE messages to pending gossip
   * @param {Peer} peer
   * @param {Array<ControlIHave>} controlIHaveMsgs
   * @returns {void}
   */
  _pushGossip (peer: Peer, controlIHaveMsgs: ControlIHave): void {
    this.log('Add gossip to %s', peer.id.toB58String())
    const gossip = this.gossip.get(peer) || []
    this.gossip.set(peer, gossip.concat(controlIHaveMsgs))
  }

  /**
   * Returns the current time in milliseconds
   * @returns {number}
   */
  _now (): number {
    return Date.now()
  }
}

export = Gossipsub
