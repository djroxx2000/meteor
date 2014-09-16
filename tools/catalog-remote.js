var fs = require('fs');
var path = require('path');
var Future = require('fibers/future');
var _ = require('underscore');
var auth = require('./auth.js');
var httpHelpers = require('./http-helpers.js');
var release = require('./release.js');
var files = require('./files.js');
var ServiceConnection = require('./service-connection.js');
var utils = require('./utils.js');
var buildmessage = require('./buildmessage.js');
var compiler = require('./compiler.js');
var uniload = require('./uniload.js');
var tropohouse = require('./tropohouse.js');
var config = require('./config.js');
var semver = require('semver');
var packageClient = require('./package-client.js');
var sqlite3 = require('../dev_bundle/bin/node_modules/sqlite3');

//PASCAL NOTES
//offline mode?
//What are the options that are passed to the initialize method in catalog?
//Do we care about a case where the user completely busts the storage (e.g. deletes it?)
//Do we want to close the DB explicitely? Do we have good opportunities to do this?
//Detect the case where the db has not been closed properly?? - eg. process aborted
//getData?
//WDo we want to worry about the lifecycle of the connection or just open / close everytime?
//Wehn we do transaction, then we should also need to see if there are errors reading

var RemoteCatalog = function (options) {
  var self = this;

  // Set this to true if we are not going to connect to the remote package
  // server, and will only use the cached data.json file for our package
  // information. This means that the catalog might be out of date on the latest
  // developments.
  self.offline = null;

  self.options = options || {};
};

_.extend(RemoteCatalog.prototype, {
  getVersion: function (name, version) {
    var result = this._syncQuery("SELECT content FROM versions WHERE name=? AND version=?", [name, version]);
    if(result.length === 0) {
      return null;
    }
    return result[0];
  },

  getSortedVersions: function (name) {
    var self = this;
    var match = this._getPackage(name);
    if (match === null)
      return [];
    return _.pluck(match, 'version').sort(semver.compare);
  },

  //copied from base-catalog
  getLatestMainlineVersion: function (name) {
    var self = this;
    var versions = self.getSortedVersions(name);
    versions.reverse();
    var latest = _.find(versions, function (version) {
      return !/-/.test(version);
    });
    if (!latest)
      return null;
    return self.getVersion(name, latest);
  },

  getPackage: function (name) {
    var result = this._getPackage(name);
    if (result.length === 0)
      return null;
    return result[0];
  },
  
  _getPackage: function (name) {
    return this._syncQuery("SELECT content FROM versions WHERE name=?", name);
  },

  getAllBuilds: function (name, version) {
    var result = this._syncQuery("SELECT * FROM builds WHERE builds.versionId = (SELECT id FROM versions WHERE versions.name=? AND versions.version=?)", [name, version]);
    if (result.length === 0)
      return null;
    return result[0];
  },

  getBuildsForArches: function (name, version, arches) {
    var solution = null;
    var allBuilds = getAllBuilds(name, version);

    //TODO see if we can share this code with the code in base-catalog...
    utils.generateSubsetsOfIncreasingSize(allBuilds, function (buildSubset) {
        // This build subset works if for all the arches we need, at least one
        // build in the subset satisfies it. It is guaranteed to be minimal,
        // because we look at subsets in increasing order of size.
        var satisfied = _.all(arches, function (neededArch) {
          return _.any(buildSubset, function (build) {
            var buildArches = build.buildArchitectures.split('+');
            return !!archinfo.mostSpecificMatch(neededArch, buildArches);
          });
        });
        if (satisfied) {
          solution = buildSubset;
          return true;  // stop the iteration
        }
      });
      return solution;  // might be null!
  },

  // Returns general (non-version-specific) information about a
  // release track, or null if there is no such release track.
  getReleaseTrack: function (name) {
    var self = this;
    var result = self._syncQuery("SELECT content FROM releaseTracks WHERE name=?", name);
    if (result.length === 0)
      return null;
    return result[0];
  },

  getReleaseVersion: function (track, version) {
    var self = this;
    var result = self._syncQuery("SELECT content FROM releaseVersions WHERE track=? AND version=?", [track, version]);
    if (result.length === 0)
      return null;
    return result[0];
  },

  //TODO see if we can use the _syncQuery function
  getAllReleaseTracks: function () {
     var future = new Future;
     var result = [];
     db.all("SELECT name FROM releaseTracks", function(err, rows) {
      if ( ! (err === null) ) {
        future.return();
        return;
      }
      result = _.pluck(rows, 'name');
      future.return();
    });
    future.wait();
    return result;
  },

  getAllPackageNames: function () {
     var future = new Future;
     var result = [];
     db.all("SELECT name FROM packages", function(err, rows) {
      if ( ! (err === null) ) {
        future.return();
        return;
      }
      result = _.pluck(rows, 'name');
      future.return();
    });
    future.wait();
    return result;
  },

  initialize: function (options) {
    //PASCAL deal with offline mode?
    var self = this;

    // We should to figure out if we are intending to connect to the package server.
    self.offline = options.offline ? options.offline : false;

    var dbFile = self.options.packageStorage || config.getPackageStorage();
    db = new sqlite3.Database(dbFile);
    if ( !fs.existsSync(path.dirname(dbFile)) ) {
      fs.mkdirSync(path.dirname(dbFile));
    }
    var future = new Future;
    db.serialize(function() {
      db.run("BEGIN TRANSACTION");
      db.run("CREATE TABLE IF NOT EXISTS versions (name STRING, version STRING, id String, content STRING)");
      db.run("CREATE INDEX IF NOT EXISTS versionsNamesIdx ON versions(name)");

      db.run("CREATE TABLE IF NOT EXISTS builds (versionId STRING, id STRING, content STRING)");
      db.run("CREATE INDEX IF NOT EXISTS buildsVersionsIdx ON builds(versionId)");

      db.run("CREATE TABLE IF NOT EXISTS releaseTracks (name STRING, id STRING, content STRING)");
      db.run("CREATE TABLE IF NOT EXISTS releaseVersions (track STRING, version STRING, id STRING, content STRING)");
      db.run("CREATE TABLE IF NOT EXISTS packages (name STRING, id STRING, content STRING)");
      db.run("CREATE TABLE IF NOT EXISTS syncToken (id STRING, content STRING)");
      db.run("END TRANSACTION", function(err, row) {
        if (err)
          console.log("TRANSACTION PB 1 " + err);
        //PASCAL check errors
        future.return();
      });
    });
    future.wait();
  },

  reset: function () {
    var self = this;
    var future = new Future;
    db.serialize(function() {
      db.run("BEGIN TRANSACTION");
      db.run("DELETE FROM versions");
      db.run("DELETE FROM builds");
      db.run("DELETE FROM releaseTracks");
      db.run("DELETE FROM releaseVersions");
      db.run("DELETE FROM packages");
      db.run("DELETE FROM syncToken");
      db.run("END TRANSACTION", function(err, row) {
        if (err)
          console.log("TRANSACTION PB 2 " + err);
        //PASCAL check errors
        future.return();
      });
    });
    future.wait();
  },

  refresh: function (overrides) {
    var self = this;
    if (self.offline)
      return;
    packageClient.updateServerPackageData(this);
  },

  refreshInProgress: function () {
    return false;
    // var self = this;
    // return self._refreshFiber === Fiber.current;
  },

  // Given a release track, return all recommended versions for this track, sorted
  // by their orderKey. Returns the empty array if the release track does not
  // exist or does not have any recommended versions.
  getSortedRecommendedReleaseVersions: function (track, laterThanOrderKey) {
    var self = this;
    var result = self._syncQuery("SELECT content FROM releaseVersions WHERE track=?", track);

    var recommended = _.filter(result, function (v) {
      if (!v.recommended)
        return false;
      return !laterThanOrderKey || v.orderKey > laterThanOrderKey;
    });

    var recSort = _.sortBy(recommended, function (rec) {
      return rec.orderKey;
    });
    recSort.reverse();
    return _.pluck(recSort, "version");
  },

  getDefaultReleaseVersion: function (track) {
    var self = this;

    if (!track)
      track = exports.DEFAULT_TRACK;

    var versions = self.getSortedRecommendedReleaseVersions(track);
    if (!versions.length)
      return null;
    return {track: track, version: versions[0]};
  },

  // Unlike the previous, this looks for a build which *precisely* matches the
  // given buildArchitectures string. Also, it takes a versionRecord rather than
  // name/version.
  getBuildWithPreciseBuildArchitectures: function (versionRecord, buildArchitectures) {
    var self = this;
    var matchingBuilds = this._syncQuery("SELECT content FROM builds WHERE versionId=?", versionRecord._id);
    return _.findWhere(matchingBuilds, { buildArchitectures: buildArchitectures });
  },

  isLocalPackage : function() {
    return false;
  },

  _syncQuery: function (query, values) {
     var future = new Future;
     var result = [];
     db.all(query, values, function(err, rows) {
      if ( !(err === null) ) {
        future.return();
        return result;
      }

      result = _.map(rows, function(entity) {
        return JSON.parse(entity.content);
      });
      future.return();
    });
    future.wait();
    return result;
  },

  _generateQuestionMarks : function (nbr) {
    var result = "(";
    for (var i = nbr - 1; i >= 0; i--) {
      result += "?" + (i !== 0 ? "," : "");
    }
    result += ")";
    return result;
  },

  _insertInTable : function(data, table, selFields, db) {
    var queryParams = this._generateQuestionMarks(selFields.length + 1);
    var insertVersion = db.prepare("INSERT INTO " + table + " VALUES " + queryParams);
    var deleteVersion = db.prepare("DELETE FROM " + table + " WHERE id=?");
    _.each(data, function (entry) {
      db.get("SELECT * FROM " + table + " WHERE id=?", entry._id, function(err, row) {
        //TOO do we need to check for error?
        if ( ! (row === undefined) ) {
          deleteVersion.run(entry._id);
        }
        var insertParam = [];
        _.each(selFields, function (field) {
          insertParam.push(entry[field]);
        });
        insertParam.push(JSON.stringify(entry));
        insertVersion.run(insertParam);
      });
    });
  },

  _insertPackages : function(packagesData, db) {
    this._insertInTable(packagesData, "packages", ['name', '_id'], db);
  },

  _insertVersions : function(versionsData, db) {
    this._insertInTable(versionsData, "versions", ['packageName', 'version', '_id'], db);
  },

  _insertBuilds : function(buildsData, db) {
    this._insertInTable(buildsData, "builds", ['versionId', '_id'], db);
  },

  _insertReleaseTracks : function(releaseTrackData, db) {
    this._insertInTable(releaseTrackData, "releaseTracks", ['name', '_id'], db);
  },

  _insertReleaseVersions : function(releaseVersionData, db) {
    this._insertInTable(releaseVersionData, "releaseVersions", ['track', 'version', '_id'], db);
  },

  _insertTimestamps : function(syncToken, db) {
    syncToken._id="1"; //Add fake _id so it fits the pattern
    this._insertInTable([syncToken], "syncToken", ['_id'], db);
  },

  insertData : function(serverData) {
    var self = this;
    var future = new Future;
    db.serialize(function() {
      db.run("BEGIN TRANSACTION");
      self._insertPackages(serverData.collections.packages, db);
      self._insertBuilds(serverData.collections.builds, db);
      self._insertVersions(serverData.collections.versions, db);
      self._insertReleaseTracks(serverData.collections.releaseTracks, db);
      self._insertReleaseVersions(serverData.collections.releaseVersions, db);
      self._insertTimestamps(serverData.syncToken, db);
      db.run("END TRANSACTION", function(err, row) {
        if (err)
          console.log("TRANSACTION PB 3 " + err);
        //PASCAL check errors
        future.return();
      });
    });
    future.wait();
  },

  getLoadPathForPackage : function (name, version, constraintSolverOpts) {
    var packageDir = tropohouse.default.packagePath(name, version);
    if (fs.existsSync(packageDir)) {
      return packageDir;
    }
    return null;
  },

  getSyncToken : function() {
    var self = this;
    var result = self._syncQuery("SELECT content FROM syncToken", []);
    if (result.length === 0)
      return {};
    delete result[0]._id;
    return result[0];
  }

});
exports.RemoteCatalog = RemoteCatalog;
exports.DEFAULT_TRACK = 'METEOR';