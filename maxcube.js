var MaxCubeLowLevel = require('./maxcube-lowlevel');
var MaxCubeCommandParser = require('./maxcube-commandparser');
var MaxCubeCommandFactory = require('./maxcube-commandfactory');
var util = require('util');
var EventEmitter = require('events').EventEmitter;

// Constructor
function MaxCube(ip, port) {
  var self = this;
  this.maxCubeLowLevel = new MaxCubeLowLevel(ip, port);
  this.maxCubeLowLevel.connect();

  this.waitForCommandType = undefined;
  this.waitForCommandResolver = undefined;
  this.initialised = false;

  this.setMaxListeners(1024);

  this.commStatus = {
    duty_cycle: 0,
    free_memory_slots: 0,
  }
  this.metaInfo = {
    serial: null,
    firmware_version: null,
  }
  this.roomCache = [];
  this.deviceCache = {};
  this.configCache = {};

  this.maxCubeLowLevel.on('closed', function () {
    if( self.waitForCommandResolver ) {
      self.waitForCommandResolver.reject( 'closed' );
      self.waitForCommandType = undefined;
      self.waitForCommandResolver = undefined;
    }
    self.emit('closed');
  });

  this.maxCubeLowLevel.on('connected', function () {
    if (!self.initialised) {
      waitForCommand.call(self, 'M').then(function () {
        self.emit('connected');
      });
    } else {
      self.emit('connected');
    }
  });

  this.maxCubeLowLevel.on('error', function( err ) {
    self.initialised = false;
    if( self.waitForCommandResolver ) {
      self.waitForCommandResolver.reject( 'closed' );
      self.waitForCommandType = undefined;
      self.waitForCommandResolver = undefined;
    }
    self.emit('error', err);
  });

  this.maxCubeLowLevel.on('command', function (command) {
    try {
      var parsedCommand = MaxCubeCommandParser.parse(command.type, command.payload);
      if (self.waitForCommandType === command.type && self.waitForCommandResolver) {
        self.waitForCommandResolver.resolve(parsedCommand);
        self.waitForCommandType = undefined;
        self.waitForCommandResolver = undefined;
      }

      switch (command.type) {
        case 'H': {
          self.commStatus.duty_cycle        = parsedCommand.duty_cycle;
          self.commStatus.free_memory_slots = parsedCommand.free_memory_slots;
          self.metaInfo.serial_number       = parsedCommand.serial_number;
          self.metaInfo.firmware_version    = parsedCommand.firmware_version;
          self.emit('hello', parsedCommand);
          break;
        }
        case 'M': {
          self.roomCache = parsedCommand.rooms;
          self.deviceCache = parsedCommand.devices;
          self.initialised = true;
          self.emit('meta_data', parsedCommand);
          break;
        }
        case 'L': {
          self.updateDeviceInfo(parsedCommand);
          self.emit('device_list', parsedCommand);
          break;
        }
        case 'C': {
          self.updateDeviceConfig(parsedCommand);
          self.emit('configuration', parsedCommand);
          break;
        }
      }
    } catch (e) {
        self.emit('error', "Problem while parsing the command '" +command.type+"': " + e.stack);
    }
  });

  this.updateDeviceInfo = function(devices)
  {
    if (typeof devices != 'undefined')
    {
      for(var i=0; i < devices.length ; i++)
      {
        var deviceInfo = devices[i];
        var rf = deviceInfo.rf_address;
        if (typeof self.deviceCache[rf] != 'undefined')
        {
          for(var item in deviceInfo)
          {
            var val = deviceInfo[item];
            self.deviceCache[rf][item] = val;
          }
        }
      }
    }
  }

  this.updateDeviceConfig = function(deviceConfig){
    if (typeof deviceConfig != 'undefined'){
      var rf = deviceConfig.rf_address;
      self.configCache[rf] = deviceConfig;
    }
  }
}

util.inherits(MaxCube, EventEmitter);

function waitForCommand (commandType) {
  this.waitForCommandType = commandType;
  var myResolve;
  var myReject;
  this.waitForCommandResolver = new Promise((resolve, reject) =>
    {
      myresolve = resolve;
      myreject = reject;
    });
  this.waitForCommandResolver.resolve = myresolve;  
  this.waitForCommandResolver.reject = myreject;  
  return this.waitForCommandResolver;
}

function send( command, replyCommandType, timeout=0 ) {
  var self = this;
  return self.getConnection().then(function () {
    if( replyCommandType ) {
      // On commands with expected reply set a timeout if requested
      self.maxCubeLowLevel.send( command, timeout );
      return waitForCommand.call(self, replyCommandType);
    } else {
      // Don't set a timeout on commands that don't expect a reply.
      self.maxCubeLowLevel.send( command, 0 );
      return Promise.resolve();
    }
  });
}

function checkInitialised() {
  if (!this.initialised) {
    throw Error('Maxcube not initialised');
  }
}

MaxCube.prototype.getConnection = function() {
  return this.maxCubeLowLevel.connect();
}

MaxCube.prototype.getCommStatus = function() {
  return this.commStatus;
}

MaxCube.prototype.getDeviceStatus = function(rf_address=undefined, timeout=0) {
  checkInitialised.call(this);

  return send.call(this, 'l:\r\n', 'L', timeout).then(function (devices) {
    if (rf_address) {
      return devices.filter(function(device) {
        return device.rf_address === rf_address;
      });
    } else {
      return devices;
    }
  });
};

MaxCube.prototype.updateDeviceStatus = function() {
  checkInitialised.call(this);

  send.call(this, 'l:\r\n');
};

MaxCube.prototype.getDevices = function() {
  checkInitialised.call(this);

  return this.deviceCache;
};

MaxCube.prototype.getDevice = function(rf_address) {
  checkInitialised.call(this);

  return this.deviceCache[rf_address];
};

MaxCube.prototype.getDeviceInfo = function(rf_address) {
  checkInitialised.call(this);

  var deviceInfo = {
    device_type: null,
    device_name: null,
    room_name: null,
    room_id: null,
    battery_low: null,
    panel_locked: null
  };

  var device = this.deviceCache[rf_address];
  if (device) {
    deviceInfo.device_type = device.device_type;
    deviceInfo.device_name = device.device_name;
    deviceInfo.battery_low = device.battery_low;
    deviceInfo.panel_locked= device.panel_locked;

    if (device.room_id && this.roomCache[device.room_id]) {
      var room = this.roomCache[device.room_id];
      deviceInfo.room_name = room.room_name;
      deviceInfo.room_id = room.room_id;
    }
  }

  return deviceInfo;
};

MaxCube.prototype.getDeviceConfiguration = function(rf_address) {
  checkInitialised.call(this);
  var deviceConfig = {}
  var config = this.configCache[rf_address];
  if (config) {
    for(var item in config) {
      var val = config[item];
      deviceConfig[item] = val;
    }
  }
  return deviceConfig;
};

MaxCube.prototype.getRooms = function() {
  checkInitialised.call(this);

  return this.roomCache;
};

MaxCube.prototype.flushDeviceCache = function() {
  checkInitialised.call(this);

  return send.call(this, 'm:\r\n');
};

MaxCube.prototype.resetError = function(rf_address, timeout=0) {
  checkInitialised.call(this);

  return send.call(this, MaxCubeCommandFactory.generateResetCommand(rf_address, this.deviceCache[rf_address].room_id), 'S', timeout);
};

MaxCube.prototype.sayHello = function(timeout=0) {
  checkInitialised.call(this);

  return send.call(this, 'h:\r\n', 'H', timeout).then(function (res) {
    self.commStatus.duty_cycle = res.duty_cycle;
    self.commStatus.free_memory_slots = res.free_memory_slots;
    return true;
  });
};

MaxCube.prototype.setTemperature = function(rf_address, degrees, mode, untilDate, timeout=0) {
  checkInitialised.call(this);

  var self = this;
  degrees = Math.max(2, degrees);
  var command = MaxCubeCommandFactory.generateSetTemperatureCommand (rf_address, this.deviceCache[rf_address].room_id, mode || 'MANUAL', degrees, untilDate);
  return send.call(this, command, 'S', timeout).then(function (res) {
    self.commStatus.duty_cycle = res.duty_cycle;
    self.commStatus.free_memory_slots = res.free_memory_slots;
    return res.accepted;
  });
};

MaxCube.prototype.setSchedule = function(rf_address, room_id, weekday, temperaturesArray, timesArray, timeout=0) {
  // weekday:           0=mo,1=tu,..,6=su
  // temperaturesArray: [19.5,21,..] degrees Celsius (max 7)
  // timesArray:        ['HH:mm',..] 24h format (max 7, same amount as temperatures)
  // the first time will be the time (from 00:00 to timesArray[0]) that the first temperature is active. Last possibe time of the day: 00:00

  checkInitialised.call(this);

  var self = this;

  var command = MaxCubeCommandFactory.generateSetDayProgramCommand (rf_address, room_id, weekday, temperaturesArray, timesArray);
  return send.call(this, command, 'S', timeout).then(function (res) {
    self.commStatus.duty_cycle = res.duty_cycle;
    self.commStatus.free_memory_slots = res.free_memory_slots;
    return res.accepted;
  });
};

MaxCube.prototype.close = function() {
  this.maxCubeLowLevel.close();
};

MaxCube.prototype.disconnect = function() {
  send.call(this, 'q:\r\n');
};

module.exports = MaxCube;
