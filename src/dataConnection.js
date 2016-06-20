'use strict';

const Connection = require('./connection');
const util       = require('./util');
const Enum       = require('enum');
const sizeof     = require('object-sizeof');

const DCEvents = new Enum([
  'open',
  'data',
  'error'
]);

const DCSerializations = new Enum([
  'binary',
  'binary-utf8',
  'json',
  'none'
]);

/**
 * Class that manages data connections to other peers.
 * @extends Connection
 */
class DataConnection extends Connection {
  /**
   * Create a data connection to another peer.
   * @param {string} remoteId - The peerId of the peer you are connecting to.
   * @param {object} [options] - Optional arguments for the connection.
   * @param {string} [options.connectionId] - An ID to uniquely identify the connection. Defaults to random string if not specified.
   * @param {string} [options.serialization] - How to serialize data when sending. One of 'binary', 'json' or 'none'.
   * @param {string} [options.label] - Label to easily identify the connection on either peer.
   * @param {string} [options.queuedMessages] - An array of messages that were already received before the connection was created.
   * @param {string} [options.payload] - An offer message that triggered creating this object.
   */
  constructor(remoteId, options) {
    super(remoteId, options);

    this._idPrefix = 'dc_';
    this.type = 'data';

    /**
     * Label to easily identify the DataConnection on either peer.
     * @type {string}
     */
    this.label = this._options.label || this.id;

    // Serialization is binary by default
    if (this._options.serialization) {
      if (!DataConnection.SERIALIZATIONS.get(this._options.serialization)) {
        // Can't emit error as there hasn't been a chance to set up listeners
        throw new Error('Invalid serialization');
      }
      this.serialization = this._options.serialization;
    } else {
      this.serialization = DataConnection.SERIALIZATIONS.binary.key;
    }

    // New send code properties
    this._sendBuffer = [];
    this._receivedData = {};
    // Messages stored by peer because DC was not ready yet
    this._queuedMessages = this._options.queuedMessages || [];

    // Maybe don't need this anymore
    if (this._options.payload) {
      this._peerBrowser = this._options.payload.browser;
    }

    // This replaces the PeerJS 'initialize' method
    this._negotiator.on('dcReady', dc => {
      this._dc = dc;
      this._dc.binaryType = 'arraybuffer';
      this._setupMessageHandlers();
    });

    this._negotiator.startConnection(
      this._options.payload || {
        originator: true,
        type:       'data',
        label:      this.label
      }
    );
    this._pcAvailable = true;

    this._handleQueuedMessages();
  }

  /**
   * Set up data channel event and message handlers.
   * @private
   */
  _setupMessageHandlers() {
    this._dc.onopen = () => {
      util.log('Data channel connection success');
      this.open = true;
      this.emit(DataConnection.EVENTS.open.key);
    };

    // We no longer need the reliable shim here
    this._dc.onmessage = msg => {
      this._handleDataMessage(msg);
    };

    this._dc.onclose = () => {
      util.log('DataChannel closed for:', this.id);
      this.close();
    };
  }

  /**
   * Handle a data message from the peer.
   * @param {object} msg - The data message to handle.
   * @private
   */
  _handleDataMessage(msg) {
    if (this.serialization === DataConnection.SERIALIZATIONS.none.key) {
      this.emit(DataConnection.EVENTS.data, msg.data);
      return;
    } else if (this.serialization === DataConnection.SERIALIZATIONS.json.key) {
      this.emit(DataConnection.EVENTS.data, JSON.parse(msg.data));
      return;
    }

    // Everything below is for serialization binary or binary-utf8

    const dataMeta = util.unpack(msg.data);

    // If we haven't started receiving pieces of data with a given id, this will be undefined
    // In that case, we need to initialise receivedData[id] to hold incoming file chunks
    let currData = this._receivedData[dataMeta.id];
    if (!currData) {
      currData = this._receivedData[dataMeta.id] = {
        size:          dataMeta.size,
        type:          dataMeta.type,
        name:          dataMeta.name,
        mimeType:      dataMeta.mimeType,
        totalParts:    dataMeta.totalParts,
        parts:         new Array(dataMeta.totalParts),
        receivedParts: 0
      };
    }
    currData.receivedParts++;
    currData.parts[dataMeta.index] = dataMeta.data;

    if (currData.receivedParts === currData.totalParts) {
      delete this._receivedData[dataMeta.id];

      // recombine the sliced arraybuffers
      let ab = util.joinArrayBuffers(currData.parts);
      let unpackedData = util.unpack(ab);

      this.emit(DataConnection.EVENTS.data.key, unpackedData);
    }
  }

  /**
   * Send data to peer. If serialization is 'binary', it will chunk it before sending.
   * @param {*} data - The data to send to the peer.
   */
  send(data) {
    if (!this.open) {
      this.emit(
        DataConnection.EVENTS.error.key,
        new Error('Connection is not open. You should listen for the `open` event before sending messages.')
      );
      return;
    }

    if (data === undefined || data === null) {
      return;
    }

    if (this.serialization === DataConnection.SERIALIZATIONS.none.key) {
      this._sendBuffer.push(data);
      this._startSendLoop();
      return;
    } else if (this.serialization === DataConnection.SERIALIZATIONS.json.key) {
      this._sendBuffer.push(JSON.stringify(data));
      this._startSendLoop();
      return;
    }

    // Everything below is for serialization binary or binary-utf8

    let packedData = util.pack(data);
    let size = packedData.size;
    let type = data.constructor.name;

    const dataMeta = {
      id:         util.randomId(),
      type:       type,
      size:       size,
      totalParts: 0
    };

    if (type === 'file') {
      dataMeta.name = data.name;
    }
    if (data instanceof Blob) {
      dataMeta.mimeType = data.type;
    }

    // dataMeta contains all possible parameters by now.
    // Adjust the chunk size to avoid issues with sending
    const chunkSize = util.maxChunkSize - sizeof(dataMeta);
    const numSlices = Math.ceil(size / chunkSize);
    dataMeta.totalParts = numSlices;

    // Perform any required slicing
    for (let sliceIndex = 0; sliceIndex < numSlices; sliceIndex++) {
      const slice = packedData.slice(sliceIndex * chunkSize, (sliceIndex + 1) * chunkSize);
      dataMeta.index = sliceIndex;
      dataMeta.data = slice;

      // Add all chunks to our buffer and start the send loop (if we haven't already)
      util.blobToArrayBuffer(util.pack(dataMeta), ab => {
        this._sendBuffer.push(ab);
        this._startSendLoop();
      });
    }
  }

  /**
   * Start sending messages at intervals to allow other threads to run.
   * @private
   */
  _startSendLoop() {
    if (!this.sendInterval) {
      // Define send interval
      // Try sending a new chunk with every callback
      this.sendInterval = setInterval(() => {
        // Might need more extensive buffering than this:
        let currMsg = this._sendBuffer.shift();
        try {
          this._dc.send(currMsg);
        } catch (error) {
          this._sendBuffer.push(currMsg);
        }

        if (this._sendBuffer.length === 0) {
          clearInterval(this.sendInterval);
          this.sendInterval = undefined;
        }
      }, util.sendInterval);
    }
  }

  /**
   * Possible serializations for the DataConnection.
   * @type {Enum}
   */
  static get SERIALIZATIONS() {
    return DCSerializations;
  }

  /**
   * Events the DataConnection class can emit.
   * @type {Enum}
   */
  static get EVENTS() {
    return DCEvents;
  }

  /**
   * DataConnection created event.
   *
   * @event DataConnection#open
   */

  /**
   * Data received from peer.
   *
   * @event DataConnection#data
   * @type {*}
   */

  /**
   * Error occurred.
   *
   * @event DataConnection#error
   * @type {Error}
   */
}

module.exports = DataConnection;
