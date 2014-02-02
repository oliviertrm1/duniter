var jpgp       = require('../lib/jpgp');
var async      = require('async');
var request    = require('request');
var mongoose   = require('mongoose');
var vucoin     = require('vucoin');
var _          = require('underscore');
var THTEntry   = mongoose.model('THTEntry');
var Amendment  = mongoose.model('Amendment');
var PublicKey  = mongoose.model('PublicKey');
var Membership = mongoose.model('Membership');
var Voting     = mongoose.model('Voting');
var Merkle     = mongoose.model('Merkle');
var Vote       = mongoose.model('Vote');
var Peer       = mongoose.model('Peer');
var Key        = mongoose.model('Key');
var Forward    = mongoose.model('Forward');
var Status     = require('../models/statusMessage');
var log4js     = require('log4js');
var logger     = log4js.getLogger('peering');

module.exports.get = function (pgp, currency, conf) {

  var ParametersService = require('./ParametersService');

  this.createNext = function (am, done) {
    var amNext = new Amendment();
    var membersMerklePrev = [];
    var votersMerklePrev = [];
    async.waterfall([
      function(next){
        amNext.selfGenerated = true;
        if (am) {
          ["version", "currency", "membersRoot", "membersCount", "votersRoot", "votersCount", "monetaryMass"].forEach(function(property){
            amNext[property] = am[property];
          });
          amNext.number = am.number + 1;
          amNext.previousHash = am.hash;
          amNext.generated = am.generated + conf.sync.votingFrequence;
          amNext.membersChanges = [];
          amNext.votersChanges = [];
        } else {
          amNext.version = 1;
          amNext.currency = currency;
          amNext.number = 0;
          amNext.generated = conf.sync.votingStart;
          amNext.membersChanges = [];
          amNext.membersRoot = "";
          amNext.membersCount = 0;
          amNext.votersChanges = [];
          amNext.votersRoot = "";
          amNext.votersCount = 0;
          amNext.monetaryMass = 0;
        }
        // Time for Universal Dividend
        var delayPassedSinceRootAM = (amNext.generated - conf.sync.votingStart);
        if (delayPassedSinceRootAM > 0 && delayPassedSinceRootAM % conf.sync.UDFrequence == 0) {
          var monetaryMassDelta = am.monetaryMass * conf.sync.UDPercent;
          var dividendPerMember = monetaryMassDelta / am.membersCount;
          amNext.dividend = Math.max(conf.sync.UDMin, Math.floor(dividendPerMember));
          amNext.monetaryMass += am.dividend * am.membersCount;
        }
        amNext.nextVotes = Math.ceil(((am && am.votersCount) || 0) * conf.sync.VotesPercent);
        // Computes changes due to too old JOIN/ACTUALIZE
        var exclusionDate = getExclusionDate(amNext);
        Membership.getCurrentJoinOrActuOlderThan(exclusionDate, next);
      },
      function (membershipsToExclude, next){
        var changes = [];
        membershipsToExclude.forEach(function(ms){
          changes.push("-" + ms.issuer);
        });
        changes.sort();
        amNext.membersChanges = changes;
        if (am) {
          Merkle.membersWrittenForAmendment(am.number, am.hash, function (err, merkle) {
            next(err, (merkle && merkle.leaves()) || []);
          });
        } else {
          next(null, []);
        }
      },
      function (leaves, next){
        membersMerklePrev = leaves;
        Merkle.membersWrittenForProposedAmendment(amNext.number, next);
      },
      function (merkle, next){
        var leaves = membersMerklePrev;
        // Remove from Merkle members not actualized
        amNext.membersChanges.forEach(function(change){
          var issuer = change.substring(1);
          var index = leaves.indexOf(issuer);
          if (~index) {
            leaves.splice(index, 1);
          }
        });
        merkle.initialize(leaves);
        amNext.membersRoot = merkle.root();
        amNext.membersCount = leaves.length;
        merkle.save(function (err) {
          next(err);
        });
      },
      function (next){
        if (am) {
          Merkle.votersWrittenForAmendment(am.number, am.hash, function (err, merkle) {
            next(err, (merkle && merkle.leaves()) || []);
          });
        } else {
          next(null, []);
        }
      },
      function (leaves, next){
        votersMerklePrev = leaves;
        Merkle.votersWrittenForProposedAmendment(amNext.number, next);
      },
      function (merkle, next){
        merkle.initialize(votersMerklePrev);
        merkle.save(function (err) {
          next(err);
        });
      },
      function (next){
        // Finally save proposed amendment
        amNext.membersRoot = amNext.membersRoot || "";
        amNext.votersRoot = amNext.votersRoot || "";
        amNext.hash = amNext.getRaw().hash();
        amNext.save(function (err) {
          next(err);
        });
      },
    ], done);
  };

  this.submit = function (signedEntry, done) {
    
    async.waterfall([

      function (callback) {
        if(signedEntry.indexOf('-----BEGIN') == -1){
          callback('Signature not found in given Membership');
          return;
        }
        callback();
      },

      // Check signature's key ID
      function(callback){
        var sig = signedEntry.substring(signedEntry.indexOf('-----BEGIN'));
        var keyID = jpgp().signature(sig).issuer();
        if(!(keyID && keyID.length == 16)){
          callback('Cannot identify signature issuer`s keyID');
          return;
        }
        callback(null, keyID);
      },

      // Looking for corresponding public key
      function(keyID, callback){
        PublicKey.getTheOne(keyID, function (err, pubkey) {
          callback(err, pubkey);
        });
      },

      // Verify signature
      function(pubkey, callback){
        var entry = new Membership();
        var current = null;
        var nowIsIgnored = false;
        async.waterfall([
          function (next){
            entry.parse(signedEntry, next);
          },
          function (entry, next){
            entry.verify(currency, next);
          },
          function (valid, next){
            entry.verifySignature(pubkey.raw, next);
          },
          function (verified, next){
            if(!verified){
              next('Bad signature');
              return;
            }
            if(pubkey.fingerprint != entry.issuer){
              next('Fingerprint in Membership (' + entry.issuer + ') does not match signatory (' + pubkey.fingerprint + ')');
              return;
            }
            next();
          },
          function (next){
            Membership.find({ issuer: pubkey.fingerprint, hash: entry.hash }, next);
          },
          function (entries, next){
            if (entries.length > 0) {
              next('Already received membership');
              return;
            }
            next();
          },
          function (next){
            // var timestampInSeconds = parseInt(entry.sigDate.getTime()/1000, 10);
            // Amendment.findPromotedPreceding(timestampInSeconds, next);
            Amendment.current(function (err, am) {
              next(null, am);
            });
          },
          function (am, next){
            if (am) {
              var entryTimestamp = parseInt(entry.sigDate.getTime()/1000, 10);
              if (am.generated > entryTimestamp) {
                next('Too late for this membership. Retry.');
                return;
              }
              entry.amNumber = am.number;
            } else {
              entry.amNumber = -1;
            }
            Membership.getCurrent(next);
          },
          function (currentlyRecorded, next){
            current = currentlyRecorded;
            // Case new is JOIN
            if (entry.membership == 'JOIN') {
              if (current && (current.membership == 'JOIN' || current.membership == 'ACTUALIZE')) {
                next('Already joined');
                return;
              }
            }
            else if (entry.membership == 'ACTUALIZE' || entry.membership == 'LEAVE') {
              if (!current || current.membership == 'LEAVE') {
                next('Not a member currently');
                return;
              }
            }
            next();
          },
          function (next){
            // Get already existing Membership for same amendment
            Membership.getForAmendmentAndIssuer(entry.amNumber, entry.issuer, next);
          },
          function (entries, next){
            if (entries.length > 1) {
              next('Refused: already received more than one membership for next amendment.');
              return;
            } else if(entries.length > 0){
              // Already existing membership for this AM : this membership and the previous for this AM
              // are no more to be considered
              entry.eligible = false;
              entries[0].eligible = false;
              entries[0].save(function (err) {
                nowIsIgnored = true;
                next(err);
              });
            } else {
              next();
            }
          },
          function (next){
            // Saves entry
            entry.propagated = false;
            entry.save(function (err) {
              next(err);
            });
          },
          function (next){
            Amendment.getTheOneToBeVoted(entry.amNumber + 1, next);
          },
          function (amNext, next){
            var isJoining = false;
            var isLeaving = false;
            var isCancelled = false;
            // Impacts on changes
            if (!nowIsIgnored) {
              if (entry.membership == 'JOIN') {
                isJoining = true;
              }
              else if (entry.membership == 'ACTUALIZE') {
                var index = amNext.membersChanges.indexOf('-' + entry.issuer);
                if (~index) {
                  amNext.membersChanges.splice(index, 1);
                }
              } else {
                isLeaving = true;
              }
            } else {
              // Remove what was present for members changes
              var index = amNext.membersChanges.indexOf('-' + entry.issuer);
              if (~index) {
                amNext.membersChanges.splice(index, 1);
              }
              index = amNext.membersChanges.indexOf('+' + entry.issuer);
              if (~index) {
                amNext.membersChanges.splice(index, 1);
                isCancelled = true;
              }
              // Computes regarding what is current
              var exclusionDate = getExclusionDate(amNext);
              if (current && current.membership != 'LEAVE' && current.sigDate < exclusionDate) {
                // If too old actualization
                isLeaving = true;
              }
            }
            async.waterfall([
              function(next){
                if (isCancelled) {
                  async.waterfall([
                    function (next){
                      Merkle.membersWrittenForProposedAmendment(amNext.number, next);
                    },
                    function (merkle, next){
                      merkle.remove(entry.issuer);
                      amNext.membersRoot = merkle.root();
                      amNext.membersCount = merkle.leaves().length;
                      merkle.save(function (err) {
                        next(err);
                      });
                    },
                  ], next);
                }
                else next();
              },
              function (next){
                async.parallel({
                  joining: function(callback){
                    if (isJoining) {
                      amNext.membersChanges.push('+' + entry.issuer);
                      amNext.membersChanges.sort();
                      async.waterfall([
                        function (next){
                          Merkle.membersWrittenForProposedAmendment(amNext.number, next);
                        },
                        function (merkle, next){
                          merkle.push(entry.issuer);
                          amNext.membersRoot = merkle.root();
                          amNext.membersCount = merkle.leaves().length;
                          merkle.save(function (err) {
                            next(err);
                          });
                        },
                      ], callback);
                    } else callback();
                  },
                  leaving: function(callback){
                    if (isLeaving) {
                      amNext.membersChanges.push('-' + entry.issuer);
                      amNext.membersChanges.sort();
                      async.waterfall([
                        function (next){
                          Merkle.membersWrittenForProposedAmendment(amNext.number, next);
                        },
                        function (merkle, next){
                          merkle.remove(entry.issuer);
                          amNext.membersRoot = merkle.root();
                          amNext.membersCount = merkle.leaves().length;
                          merkle.save(function (err) {
                            next(err);
                          });
                        },
                      ], callback);
                    } else callback();
                  }
                }, function(err) {
                  // Impacts on reason
                  // Impacts on tree
                  //nowIsIgnored && "Already received membership: all received membership for this key will be ignored for next amendment"

                  async.waterfall([
                    function (next){
                      amNext.membersRoot = amNext.membersRoot || "";
                      amNext.votersRoot = amNext.votersRoot || "";
                      amNext.hash = amNext.getRaw().hash();
                      amNext.save(function (err) {
                        next(err);
                      });
                    },
                    function (next) {
                      if (isCancelled) {
                        next('Cancelled: a previous membership was found, thus none of your memberships will be taken for next amendment');
                        return;
                      }
                      else next(null, entry);
                    },
                  ], next);
                });
              },
            ], next);
          },
        ], callback);
      }
    ], done);
  };

  this.submitVoting = function (signedEntry, done) {
    
    async.waterfall([

      function (callback) {
        if(signedEntry.indexOf('-----BEGIN') == -1){
          callback('Signature not found in given Voting');
          return;
        }
        callback();
      },

      // Check signature's key ID
      function(callback){
        var sig = signedEntry.substring(signedEntry.indexOf('-----BEGIN'));
        var keyID = jpgp().signature(sig).issuer();
        if(!(keyID && keyID.length == 16)){
          callback('Cannot identify signature issuer`s keyID');
          return;
        }
        callback(null, keyID);
      },

      // Looking for corresponding public key
      function(keyID, callback){
        PublicKey.getTheOne(keyID, function (err, pubkey) {
          callback(err, pubkey);
        });
      },

      // Verify signature
      function(pubkey, callback){
        var entry = new Voting();
        var current = null;
        var previous = null;
        var nowIsIgnored = false;
        async.waterfall([
          function (next){
            entry.parse(signedEntry, next);
          },
          function (entry, next){
            entry.verify(currency, next);
          },
          function (valid, next){
            entry.verifySignature(pubkey.raw, next);
          },
          function (verified, next){
            if(!verified){
              next('Bad signature');
              return;
            }
            if(pubkey.fingerprint != entry.issuer){
              next('Fingerprint in Voting (' + entry.issuer + ') does not match signatory (' + pubkey.fingerprint + ')');
              return;
            }
            next();
          },
          function (next){
            Voting.find({ issuer: pubkey.fingerprint, hash: entry.hash }, next);
          },
          function (entries, next){
            if (entries.length > 0) {
              next('Already received voting');
              return;
            }
            next();
          },
          function (next){
            // var timestampInSeconds = parseInt(entry.sigDate.getTime()/1000, 10);
            // Amendment.findPromotedPreceding(timestampInSeconds, next);
            Amendment.current(function (err, am) {
              next(null, am);
            });
          },
          function (am, next){
            if (am) {
              var entryTimestamp = parseInt(entry.sigDate.getTime()/1000, 10);
              if (am.generated > entryTimestamp) {
                next('Too late for this voting. Retry.');
                return;
              }
              entry.amNumber = am.number;
            } else {
              entry.amNumber = -1;
            }
            Voting.getCurrent(next);
          },
          function (currentlyRecorded, next){
            current = currentlyRecorded;
            async.waterfall([
              function (next){
                Merkle.membersWrittenForProposedAmendment(entry.amNumber + 1, next);
              },
              function (merkle, next){
                if (merkle.leaves().indexOf(entry.issuer) == -1) {
                  next('Only members may be voters');
                  return;
                }
                next();
              },
            ], next);
          },
          function (next){
            // Get already existing Voting for same amendment
            Voting.getForAmendmentAndIssuer(entry.amNumber, entry.issuer, next);
          },
          function (entries, next){
            if (entries.length > 1) {
              next('Refused: already received more than one voting for next amendment.');
              return;
            } else if(entries.length > 0){
              // Already existing voting for this AM : this voting and the previous for this AM
              // are no more to be considered
              entry.eligible = false;
              previous = entries[0];
              entries[0].eligible = false;
              entries[0].save(function (err) {
                nowIsIgnored = true;
                next(err);
              });
            } else {
              next();
            }
          },
          function (next){
            // Saves entry
            entry.propagated = false;
            entry.save(function (err) {
              next(err);
            });
          },
          function (next){
            Amendment.getTheOneToBeVoted(entry.amNumber + 1, next);
          },
          function (amNext, next){
            var merkleOfNextVoters;
            async.waterfall([
              function (next){
                Merkle.votersWrittenForProposedAmendment(amNext.number, next);
              },
              function (votersMerkle, next){
                merkleOfNextVoters = votersMerkle;
                if (!nowIsIgnored) {
                  var index = merkleOfNextVoters.leaves().indexOf(entry.votingKey);
                  // Case 1) key is arleady used, by the same issuer --> error
                  if (~index && current && current.votingKey == entry.votingKey) {
                    next('Already used as voting key');
                    return;
                  }
                  // Case 2) key is arleady used, by another issuer --> error
                  if (~index) {
                    next('Already used by someone else as voting key');
                    return;
                  }
                  // Case 3) key is not already used, because it is currently leaving
                  if (~amNext.votersChanges.indexOf('-' + entry.votingKey)) {
                    next('Key is currently leaving. You can use it only after voting next amendment.');
                    return;
                  }
                  // Case 4) key is not already used, but issuer has previous other key --> cancel OLD key + add new
                  if (current) {
                    next(null, current.votingKey, null, entry.votingKey, null);
                    return;
                  }
                  // Case 5) key is not arleady used, without having any previous --> add new
                  next(null, null, null, entry.votingKey, null);
                }
                else {
                  // Cancelling previous
                  // Case 1) Voting was just new voter ==> Un-add new voting key
                  if (!current) {
                    next(null, null, null, null, previous.votingKey);
                    return;
                  }
                  // Case 2) Voting was changing key ==> Un-add new voting key, unleave current
                  // TODO
                  next(null, null, current.votingKey, previous.votingKey, null);
                }
              },
              function (keyToRemove, keyToUnleave, keyToAdd, keyToUnadd, next){
                async.waterfall([
                  function (next){
                    var merkle = merkleOfNextVoters;
                    // Update keys according to what is to be added/removed
                    if (keyToRemove) {
                      merkle.remove(keyToRemove);
                    }
                    if (keyToUnadd) {
                      merkle.remove(keyToUnadd);
                    }
                    if (keyToUnleave) {
                      merkle.push(keyToUnleave);
                    }
                    if (keyToAdd) {
                      merkle.push(keyToAdd);
                    }
                    // Update resulting root + count
                    amNext.votersRoot = merkle.root();
                    amNext.votersCount = merkle.leaves().length;
                    merkle.save(function (err) {
                      next(err);
                    });
                  },
                  function (next){
                    // Update changes
                    if (keyToRemove) {
                      amNext.votersChanges.push('-' + keyToRemove);
                    }
                    if (keyToUnleave) {
                      var index = amNext.votersChanges.indexOf('-' + keyToUnleave);
                      if (~index) {
                        amNext.votersChanges.splice(index, 1);
                      }
                    }
                    if (keyToAdd) {
                      amNext.votersChanges.push('+' + keyToAdd);
                    }
                    if (keyToUnadd) {
                      var index = amNext.votersChanges.indexOf('+' + keyToUnadd);
                      if (~index) {
                        amNext.votersChanges.splice(index, 1);
                      }
                    }
                    next();
                  },
                ], next);
              },
            ], function (err) {
              async.waterfall([
                function (next){
                  amNext.membersRoot = amNext.membersRoot || "";
                  amNext.votersRoot = amNext.votersRoot || "";
                  amNext.nextVotes = Math.ceil((amNext.votersCount || 0) * conf.sync.VotesPercent);
                  amNext.hash = amNext.getRaw().hash();
                  amNext.save(function (err) {
                    next(err);
                  });
                },
                function (next) {
                  if (nowIsIgnored) {
                    next('Cancelled: a previous voting was found, thus none of your voting requests will be taken for next amendment');
                    return;
                  }
                  else next(err, entry);
                },
              ], next);
            });
          },
        ], callback);
      }
    ], done);
  };

  this.getVote = function (amNumber, done) {
    async.waterfall([
      function (next){
        Vote.getSelf(amNumber, next);
      },
      function (vote, next){
        if (vote){
          next(null, vote);
          return;
        }
        // Tries to vote
        var now = new Date();
        async.waterfall([
          function (next){
            Amendment.getTheOneToBeVoted(amNumber, next);
          },
          function (amNext, next){
            if (now.timestamp() >= amNext.generated) {

              var privateKey = pgp.keyring.privateKeys[0];
              var cert = jpgp().certificate(this.ascciiPubkey);
              var raw = amNext.getRaw();
              async.waterfall([
                function (next){
                  jpgp().signsDetached(raw, privateKey, next);
                },
                function (signature, next){
                  var signedAm = raw + signature;
                  vucoin(conf.ipv6 || conf.ipv4 || conf.dns, conf.port, false, false, function (err, node) {
                    next(null, signedAm, node);
                  });
                },
                function (vote, node, next){
                  node.hdc.amendments.votes.post(vote, next);
                },
                function (json, next){
                  var am = new Amendment(json.amendment);
                  var issuer = cert.fingerprint;
                  var hash = json.signature.unix2dos().hash();
                  var basis = json.amendment.number;
                  Vote.getByIssuerHashAndBasis(issuer, hash, basis, next);
                },
                function (vote, next){
                  if (!vote) {
                    next('Self vote was not found');
                    return;
                  }
                  vote.selfGenerated = true;
                  vote.save(function  (err) {
                    next(err, vote);
                  });
                },
              ], next);
              return;
            }
            next('Not yet');
          },
        ], next);
      },
    ], done);
  };

  function getExclusionDate (amNext) {
    var nextTimestamp = amNext.generated;
    var exclusionDate = new Date();
    exclusionDate.setTime(nextTimestamp*1000 - conf.sync.ActualizeFrequence*1000);
    return exclusionDate;
  }

  return this;
}