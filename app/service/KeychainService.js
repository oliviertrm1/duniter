var jpgp      = require('../lib/jpgp');
var async     = require('async');
var _         = require('underscore');
var openpgp   = require('openpgp');
var merkle    = require('merkle');
var base64    = require('../lib/base64');
var unix2dos  = require('../lib/unix2dos');
var dos2unix  = require('../lib/dos2unix');
var parsers   = require('../lib/streams/parsers/doc');
var keyhelper = require('../lib/keyhelper');
var logger    = require('../lib/logger')('keychain');
var signature = require('../lib/signature');
var moment    = require('moment');
var inquirer  = require('inquirer');

module.exports.get = function (conn, conf, PublicKeyService, PeeringService) {
  return new KeyService(conn, conf, PublicKeyService, PeeringService);
};

// Callback used as a semaphore to sync keyblock reception & PoW computation
var newKeyblockCallback = null;

// Callback used to start again computation of next PoW
var computeNextCallback = null;

// Flag telling if computation has started
var computationActivated = false;

function KeyService (conn, conf, PublicKeyService, PeeringService) {

  var KeychainService = this;

  var Membership = conn.model('Membership');
  var KeyBlock   = conn.model('KeyBlock');
  var PublicKey  = conn.model('PublicKey');
  var TrustedKey = conn.model('TrustedKey');
  var Link       = conn.model('Link');
  var Key        = conn.model('Key');

  // Flag to say wether timestamp of received keyblocks should be tested
  // Useful for synchronisation of old blocks
  this.checkWithLocalTimestamp = true;

  this.load = function (done) {
    done();
  };

  this.submitMembership = function (ms, done) {
    var entry = new Membership(ms);
    async.waterfall([
      function (next){
        logger.debug('⬇ %s %s', entry.issuer, entry.membership);
        // Get already existing Membership with same parameters
        Membership.getForHashAndIssuer(entry.hash, entry.issuer, next);
      },
      function (entries, next){
        if (entries.length > 0 && entries[0].date > entry.date) {
          next('Already received membership');
        }
        else Key.isMember(entry.issuer, next);
      },
      function (isMember, next){
        var isJoin = entry.membership == 'IN';
        if (!isMember && isJoin) {
          hasEligiblePubkey(entry.issuer, next);
        }
        else if (isMember && !isJoin) {
          next(null, true);
        } else {
          if (isJoin)
            next('A member cannot join in.');
          else 
            next('A non-member cannot leave.');
        }
      },
      function (isClean, next){
        if (!isClean) {
          next('Needs an eligible public key (with udid2)');
          return;
        }
        Membership.removeEligible(entry.issuer, next);
      },
      function (nbDeleted, next) {
        // Saves entry
        entry.save(function (err) {
          next(err);
        });
      },
      function (next){
        logger.debug('✔ %s %s', entry.issuer, entry.membership);
        next(null, entry);
      }
    ], done);
  };

  function hasEligiblePubkey (fpr, done) {
    async.waterfall([
      function (next){
        PublicKey.getTheOne(fpr, next);
      },
      function (pubkey, next){
        if (pubkey.keychain)
          next(null, true); // Key is already in the chain
        else {
          // Key is not in the keychain: valid if it has a valid udid2 (implying pubkey + self certificatio)
          var wrappedKey = keyhelper.fromArmored(pubkey.raw);
          next(null, wrappedKey.hasValidUdid2());
        }
      },
    ], done);
  }

  this.submitKeyBlock = function (kb, done) {
    var now = new Date();
    var block = new KeyBlock(kb);
    block.issuer = kb.pubkey.fingerprint;
    var currentBlock = null;
    var newLinks;
    async.waterfall([
      function (next){
        KeyBlock.current(function (err, kb) {
          next(null, kb || null);
        })
      },
      function (current, next){
        // Testing chaining
        if (!current && block.number > 0) {
          next('Requires root block first');
          return;
        }
        if (current && block.number <= current.number) {
          next('Too late for this block');
          return;
        }
        if (current && block.number > current.number + 1) {
          next('Too early for this block');
          return;
        }
        if (current && block.number == current.number + 1 && block.previousHash != current.hash) {
          next('PreviousHash does not target current block');
          return;
        }
        if (current && block.number == current.number + 1 && block.previousIssuer != current.issuer) {
          next('PreviousIssuer does not target current block');
          return;
        }
        // Test timestamp
        if (KeychainService.checkWithLocalTimestamp && Math.abs(block.timestamp - now.utcZero().timestamp()) > conf.tsInterval) {
          next('Timestamp does not match this node\'s time');
          return;
        }
        // Check the challenge depending on issuer
        checkProofOfWork(current, block, next);
      },
      function (next) {
        // Check document's coherence
        checkIssuer(block, next);
      },
      function (next) {
        // Check document's coherence
        checkCoherence(block, next);
      },
      function (theNewLinks, next) {
        newLinks = theNewLinks;
        // If computation is started, stop it and wait for stop event
        var isComputeProcessWaiting = computeNextCallback ? true : false;
        if (computationActivated && !isComputeProcessWaiting) {
          // Next will be triggered by computation of the PoW process
          newKeyblockCallback = next;
        } else {
          next();
        }
      },
      function (next) {
        newKeyblockCallback = null;
        // Save block data + compute links obsolescence
        saveBlockData(block, newLinks, next);
      },
      function (block, next) {
        // If PoW computation process is waiting, trigger it
        if (computeNextCallback)
          computeNextCallback();
        computeNextCallback = null;
        next();
      }
    ], function (err) {
      done(err, block);
    });
  };

  function checkIssuer (block, done) {
    async.waterfall([
      function (next){
        Key.isMember(block.issuer, next);
      },
      function (isMember, next){
        if (isMember)
          next();
        else {
          if (block.number == 0) {
            if (~block.membersChanges.indexOf('+' + block.issuer)) {
              next();
            } else {
              next('Keyblock not signed by the root members');
            }
          } else {
            next('Keyblock must be signed by an existing member');
          }
        }
      },
    ], done);
  }

  function checkCoherence (block, done) {
    var newLinks = {};
    async.waterfall([
      function (next){
        // Check key changes
        checkKeychanges(block, next);
      },
      function (theNewLinks, next) {
        newLinks = theNewLinks;
        _(newLinks).keys().forEach(function(target){
          newLinks[target].forEach(function(source){
            logger.debug('Sig %s --> %s', source, target);
          });
        });
        // Check that new links won't kick other members (existing or incoming)
        checkWoTStability(block, newLinks, next);
      },
      function (next) {
        // Check that to be kicked members are kicked
        checkKicked(block, newLinks, next);
      },
      function (next){
        // Check members' changes (+ and -), root & count
        checkCommunityChanges(block, next);
      },
    ], function (err) {
      done(err, newLinks);
    });
  }

  function checkKeychanges(block, done) {
    var newLinks = {};
    var newKeys = {};
    async.waterfall([
      function (next){
        // Memorize newKeys
        async.forEach(block.keysChanges, function(kc, callback){
          if (kc.type == 'N') {
            var key = keyhelper.fromEncodedPackets(kc.keypackets);
            newKeys[kc.fingerprint] = key;
          }
          callback();
        }, next);
      },
      function (next){
        async.forEachSeries(['N', 'U'], function(currentType, packetTypeDone) {
          async.forEachSeries(block.keysChanges, function(kc, callback){
            if (kc.type != 'U' && kc.type != 'N') {
              callback('Only NEWCOMER & UPDATE blocks are managed for now');
              return;
            }
            // Doing only one type at a time
            if (kc.type != currentType) {
              callback();
              return;
            }
            async.waterfall([
              function (next){
                // Check keychange (certifications verification notably)
                checkKeychange(block, kc, newKeys, next);
              },
              function (next){
                // Memorize new links from signatures
                newLinks[kc.fingerprint] = kc.certifiers;
                next();
              },
            ], callback);
          }, function (err) {
            packetTypeDone(err);
          });
        }, function (err) {
          next(err, newLinks);
        });
      },
    ], function (err, newLinks) {
      done(err, newLinks);
    });
  }

  function checkKeychange (block, kc, newKeys, done) {
    try {
      if (kc.type == 'N') {
        // Check NEWCOMER keychange type
        var key = keyhelper.fromEncodedPackets(kc.keypackets);
        var ms = Membership.fromInline(kc.membership.membership, kc.membership.signature);
        if (!kc.certpackets) {
          done('Certification packets are required for NEWCOMER type');
          return;
        }
        if (!kc.membership) {
          done('Membership is required for NEWCOMER type');
          return;
        }
        if (ms.membership != 'IN') {
          done('Membership must be IN for NEWCOMER type');
          return;
        }
        if (!key.hasValidUdid2()) {
          done('Key must have valid udid2 for NEWCOMER type');
          return;
        }
        if (ms.userid != key.getUserID()) {
          done('Membership must match same UserID as key');
          return;
        }
        var packets = key.getNewcomerPackets();
        var cleanOrigin = unix2dos(kc.keypackets.replace(/\n$/, ''));
        var cleanComputed = unix2dos(base64.encode(packets.write()).replace(/\n$/, ''));
        if (cleanComputed != cleanOrigin) {
          done('Only 1 pubkey, 1 udid2 userid, certifications, subkeys & subkey bindings are allowed for NEWCOMER type');
          return;
        }

        // TODO: check subkeys?

        async.parallel({
          certifications: function(callback){
            // Check certifications
            kc.certifiers = [];
            async.forEach(keyhelper.toPacketlist(kc.certpackets), function(certif, callback2){
              async.waterfall([
                function (next){
                  checkCertificationOfKey(certif, kc.fingerprint, newKeys, next);
                },
                function (certifier, next){
                  // Add certifier FPR in memory
                  kc.certifiers.push(certifier);
                  next();
                },
              ], callback2);
            }, callback);
          },
          membership: function(callback){
            // Check against signature
            var entity = new Membership(ms);
            var armoredPubkey = key.getArmored();
            async.waterfall([
              function (next){
                entity.currency = conf.currency;
                entity.userid = key.getUserID();
                jpgp()
                  .publicKey(armoredPubkey)
                  .data(entity.getRaw())
                  .signature(ms.signature)
                  .verify(next);
              },
              function (verified, next) {
                if(!verified){
                  next('Bad signature for membership of ' + entity.userid);
                  return;
                }
                next();
              },
            ], callback);
          },
        }, function(err) {
          done(err);
        });

      } else if (kc.type == 'U') {
        // Check UPDATE keychange type
        if (kc.membership) {
          done('Membership must NOT be provided for UPDATE type');
          return;
        }
        if (!kc.keypackets && !kc.certpackets) {
          done('Both KeyPackets and CertificationPakcets CANNOT be empty for UPDATE type');
          return;
        }
        if (kc.keypackets && !keyhelper.hasOnlySubkeyMaterial(kc.keypackets)) {
          done('KeyPackets MUST contain only subkeys & subkey bindings if not empty for UPDATE type');
          return;
        }
        if (kc.certpackets && !keyhelper.hasOnlyCertificationMaterial(kc.certpackets)) {
          done('CertificationPackets MUST contain only certifications if not empty for UPDATE type');
          return;
        }

        // TODO: check subkeys?

        // Check certifications
        async.forEach(keyhelper.toPacketlist(kc.certpackets), function(certif, callback){
          kc.certifiers = [];
          async.waterfall([
            function (next){
              checkCertificationOfKey(certif, kc.fingerprint, newKeys, next);
            },
            function (certifier, next){
              // Add certifier FPR in memory
              kc.certifiers.push(certifier);
              next();
            },
          ], callback);
        }, done);

      } else if (kc.type == 'L') {
        // Check LEAVER keychange type
        done('LEAVER keychange type not managed yet');

      } else if (kc.type == 'B') {
        // Check BACK keychange type
        done('BACK keychange type not managed yet');

      } else {
        done('Unknown keychange type \'' + kc.type + '\'');
      } 
    } catch (ex) {
      done(new Error(ex));
      return;
    }
  }

  function checkWoTStability (block, newLinks, done) {
    if (block.number >= 0) {
      // other blocks may introduce unstability with new members
      async.waterfall([
        function (next) {
          Key.getMembers(next);
        },
        function (members, next) {
          var newcomers = [];
          block.membersChanges.forEach(function (change) {
            if (change.match(/^\+/)) {
              var fpr = change.substring(1);
              newcomers.push(fpr);
              members.push({ fingerprint: fpr });
            }
          });
          async.forEachSeries(newcomers, function (newcomer, newcomerTested) {
            async.waterfall([
              function (next) {
                if (block.number > 0)
                  checkHaveEnoughLinks(newcomer, newLinks, next);
                else
                  next();
              },
              function (next) {
                // Check the newcomer IS RECOGNIZED BY the WoT + other newcomers
                // (check we have a path WoT => newcomer)
                Link.isOver3StepsOfAMember(newcomer, members, next);
              },
              function (firstCheck, next) {
                if (firstCheck.length > 0) {
                  // This means either:
                  //   1. WoT does not recognize the newcomer
                  //   2. Other newcomers do not recognize the newcomer since we haven't taken them into account
                  // So, we have to test with newcomers' links too
                  async.waterfall([
                    function (next) {
                      Link.isStillOver3Steps(newcomer, firstCheck, newLinks, next);
                    },
                    function (secondCheck) {
                      if (secondCheck.length > 0)
                        next('Newcomer ' + newcomer + ' is not recognized by the WoT for this block');
                      else
                        next();
                    }
                  ], next);
                } else next();
              },
              function (next) {
                // Also check that the newcomer RECOGNIZES the WoT + other newcomers
                // (check we have a path newcomer => WoT)
                async.forEachSeries(members, function (member, memberRecognized) {
                  async.waterfall([
                    function (next) {
                      Link.isStillOver3Steps(member.fingerprint, [newcomer], newLinks, next);
                    },
                    function (distances, next) {
                      if (distances.length > 0)
                        next('Newcomer ' + newcomer + ' cannot recognize member ' + member.fingerprint + ': no path found or too much distance');
                      else
                        next();
                    }
                  ], memberRecognized);
                }, next);
              }
            ], newcomerTested);
          }, next);
        }
      ], done);
    }
  }

  function checkHaveEnoughLinks(target, newLinks, done) {
    async.waterfall([
      function (next){
        Link.currentValidLinks(target, next);
      },
      function (links, next){
        var count = links.length;
        if (newLinks[target] && newLinks[target].length)
          count += newLinks[target].length;
        next(count < conf.sigQty && 'Key ' + target.substring(24) + ' does not have enough links (' + count + '/' + conf.sigQty + ')');
      },
    ], done);
  }

  function checkProofOfWork (current, block, done) {
    var powRegexp = new RegExp('^0{' + conf.powZeroMin + '}');
    if (!block.hash.match(powRegexp))
      done('Not a proof-of-work');
    else {
      // Compute exactly how much zeros are required for this block's issuer
      var lastBlockPenality = 0;
      var nbWaitedPeriods = 0;
      async.waterfall([
        function (next){
          getTrialLevel(block.issuer, block.number, current ? current.membersCount : 0, next);
        },
        function (nbZeros, next){
          var powRegexp = new RegExp('^0{' + nbZeros + ',}');
          if (!block.hash.match(powRegexp))
            next('Wrong proof-of-work level: given ' + block.hash.match(/^0+/)[0].length + ' zeros, required was ' + nbZeros + ' zeros');
          else {
            next();
          }
        },
      ], done);
    }
  }

  function getTrialLevel (issuer, nextBlockNumber, currentWoTsize, done) {
    // Compute exactly how much zeros are required for this block's issuer
    var lastBlockPenality = 0;
    var nbWaitedPeriods = 0;
    async.waterfall([
      function (next){
        KeyBlock.lastOfIssuer(issuer, next);
      },
      function (last, next){
        if (last) {
          var leadingZeros = last.hash.match(/^0+/)[0];
          lastBlockPenality = leadingZeros.length - conf.powZeroMin + 1;
          var powPeriodIsContant = conf.powPeriodC;
          var nbPeriodsToWait = (powPeriodIsContant ? conf.powPeriod : Math.floor(conf.powPeriod/100*currentWoTsize));
          nbWaitedPeriods = Math.floor((nextBlockNumber - last.number) / nbPeriodsToWait);
        }
        var nbZeros = Math.max(conf.powZeroMin, conf.powZeroMin + lastBlockPenality - nbWaitedPeriods);
        next(null, nbZeros);
      },
    ], done);
  }

  function checkKicked (block, newLinks, done) {
    var membersChanges = block.membersChanges;
    async.waterfall([
      function (next){
        Key.getToBeKicked(next);
      },
      function (keys, next){
        async.forEach(keys, function(key, callback){
          async.waterfall([
            function (next){
              var remainingKeys = [];
              key.distanced.forEach(function(m){
                remainingKeys.push(m);
              });
              async.parallel({
                outdistanced: function(callback){
                  Link.isStillOver3Steps(key.fingerprint, remainingKeys, newLinks, next);
                },
                enoughLinks: function(callback){
                  checkHaveEnoughLinks(key.fingerprint, newLinks, function (err) {
                    callback(null, err);
                  });
                },
              }, next);
            },
            function (res, next) {
              var outdistanced = res.outdistanced;
              var enoughLinksErr = res.enoughLinks;
              var isStill = outdistanced.length > 0;
              var isBeingKicked = membersChanges.indexOf('-' + key.fingerprint);
              if (isStill && isBeingKicked == -1) {
                next('Member ' + key.fingerprint + ' has to lose his member status. Wrong block.');
                return;
              }
              if (!isStill && ~isBeingKicked) {
                next('Member ' + key.fingerprint + ' is no more outdistanced and should not be kicked. Wrong block.');
                return;
              }
              if (enoughLinksErr && isBeingKicked == -1) {
                next(enoughLinksErr);
                return;
              }
              // Fine
              next();
            }
          ], callback);
        }, next);
      },
    ], done);
  }

  function checkCommunityChanges (block, done) {
    var mss = block.getMemberships().mss;
    async.waterfall([
      function (next){
        var error = null;
        _(mss).values().forEach(function(ms){
          var change = ms.membership == 'IN' ? '+' : '-';
          var fingerprint = ms.fingerprint;
          // Checking received memberships all matches a correct membersChanges entry
          if (block.membersChanges.indexOf(change + fingerprint) == -1) {
            error = 'Wrong members changes';
            return;
          }
        });
        next(error);
      },
    ], done);
  }

  function updateMembers (block, done) {
    async.forEach(block.membersChanges, function(mc, callback){
      var isPlus = mc[0] == '+';
      var fpr = mc.substring(1);
      async.waterfall([
        function (next){
          (isPlus ? Key.addMember : Key.removeMember).call(Key, fpr, next);
        },
        function (next) {
          Key.unsetKicked(fpr, next);
        }
      ], callback);
    }, done);
  }

  function saveBlockData (block, newLinks, done) {
    logger.info('Block #' + block.number + ' added to the keychain');
    async.waterfall([
      function (next) {
        // Saves the block
        block.save(function (err) {
          next(err);
        });
      },
      function (next) {
        // Update members
        updateMembers(block, next);
      },
      function (next){
        // Save new pubkeys (from NEWCOMERS)
        var pubkeys = block.getNewPubkeys();
        async.forEach(pubkeys, function(key, callback){
          var fpr = key.getFingerprint();
          var uid = key.getUserID();
          var kid = fpr.substring(24);
          var trusted = new TrustedKey({
            fingerprint: fpr,
            keyID: kid,
            uid: uid,
            packets: key.getEncodedPacketList()
          });
          async.parallel({
            trusted: function(callback){
              trusted.save(function (err){
                callback(err);
              });
            },
            pubkey: function(callback){
              async.waterfall([
                function (next){
                  parsers.parsePubkey(next).asyncWrite(unix2dos(key.getArmored()), next);
                },
                function (obj, next){
                  PublicKeyService.submitPubkey(obj, next);
                },
              ], callback);
            },
          }, function(err) {
            callback(err);
          });
        }, next);
      },
      function (next){
        // Save key updates (from UPDATE & BACK)
        var updates = block.getKeyUpdates();
        async.forEach(_(updates).keys(), function(fpr, callback){
          async.waterfall([
            function (next){
              TrustedKey.getTheOne(fpr, next);
            },
            function (trusted, next){
              var oldList = keyhelper.toPacketlist(trusted.packets);
              var newList = new openpgp.packet.List();
              if (updates[fpr].certifs) {
                // Concat signature packets behind userid + self-signature
                for (var i = 0; i < 3; i++)
                  newList.push(oldList[i]);
                newList.concat(keyhelper.toPacketlist(updates[fpr].certifs));
                // Concat remaining packets
                for (var i = 3; i < oldList.length; i++)
                  newList.push(oldList[i]);
              } else {
                // Write the whole existing key
                newList.concat(oldList);
              }
              if (updates[fpr].subkeys)
                newList.concat(keyhelper.toPacketlist(updates[fpr].subkeys));
              var key = keyhelper.fromPackets(newList);
              trusted.packets = key.getEncodedPacketList();
              trusted.save(function (err) {
                next(err);
              });
            },
          ], callback);
        }, next);
      },
      function (next){
        // Save links
        async.forEach(_(newLinks).keys(), function(target, callback){
          async.forEach(newLinks[target], function(source, callback2){
            var lnk = new Link({
              source: source,
              target: target,
              timestamp: block.timestamp
            });
            lnk.save(function (err) {
              callback2(err);
            });
          }, callback);
        }, next);
      },
      function (next){
        // Save memberships
        var mss = block.getMemberships().mss;
        async.forEach(_(mss).values(), function(ms, callback){
          Membership.removeFor(ms.fingerprint, callback);
        }, next);
      },
      function (next){
        // Compute obsolete links
        computeObsoleteLinks(block, next);
      },
      function (next){
        // Update available key material for members with keychanges in this block
        updateAvailableKeyMaterial(block, next);
      },
    ], function (err) {
      done(err, block);
    });
  }

  function computeObsoleteLinks (block, done) {
    async.waterfall([
      function (next){
        Link.obsoletes(block.timestamp - conf.sigValidity, next);
      },
      function (next){
        Key.getMembers(next);
      },
      function (members, next){
        // If a member is over 3 steps from the whole WoT, has to be kicked
        async.forEachSeries(members, function(key, callback){
          var fpr = key.fingerprint;
          async.waterfall([
            function (next){
              async.parallel({
                outdistanced: function(callback){
                  Link.isOver3StepsOfAMember(key, members, callback);
                },
                enoughLinks: function(callback){
                  checkHaveEnoughLinks(key.fingerprint, {}, function (err) {
                    callback(null, err);
                  });
                },
              }, next);
            },
            function (res, next){
              var distancedKeys = res.outdistanced;
              var notEnoughLinks = res.enoughLinks;
              Key.setKicked(fpr, distancedKeys, notEnoughLinks ? true : false, next);
            },
          ], callback);
        }, next);
      },
    ], done);
  }

  function updateAvailableKeyMaterial (block, done) {
    async.forEach(block.keysChanges, function(kc, callback){
      if (kc.type != 'L') {
        PublicKeyService.updateAvailableKeyMaterial(kc.fingerprint, callback);
      }
      else callback();
    }, done);
  }

  this.updateCertifications = function (done) {
    async.waterfall([
      function (next){
        Key.getMembers(next);
      },
      function (members, next){
        async.forEachSeries(members, function(member, callback){
          PublicKeyService.updateAvailableKeyMaterial(member.fingerprint, callback);
        }, next);
      },
    ], done);
  }

  this.current = function (done) {
    KeyBlock.current(function (err, kb) {
      done(err, kb || null);
    })
  };

  this.promoted = function (number, done) {
    KeyBlock.findByNumber(number, function (err, kb) {
      done(err, kb || null);
    })
  };

  this.generateEmptyNext = function (done) {
    var staying = [];
    var kicked = [];
    var current;
    async.waterfall([
      function (next) {
        KeyBlock.current(function (err, currentBlock) {
          current = currentBlock;
          next(err && 'No root block: cannot generate an empty block');
        });
      },
      function (next){
        Key.getMembers(next);
      },
      function (memberKeys, next){
        memberKeys.forEach(function(mKey){
          if (!mKey.kick) {
          // Member that stays
            staying.push(mKey.fingerprint);
          } else {
          // Member that leaves (kicked)
            kicked.push(mKey.fingerprint);
          }
        });
        createNextEmptyBlock(current, staying, kicked, next);
      },
    ], done);
  };

  function createNextEmptyBlock (current, members, leaving, done) {
    var block = new KeyBlock();
    block.version = 1;
    block.currency = current.currency;
    block.number = current.number + 1;
    block.previousHash = current.hash;
    block.previousIssuer = current.issuer;
    // Members merkle
    var stayers = members.slice(); // copy
    var leavers = leaving.slice(); // copy
    stayers.sort();
    leavers.sort();
    var tree = merkle(stayers, 'sha1').process();
    block.membersCount = stayers.length;
    block.membersRoot = tree.root();
    block.membersChanges = [];
    leavers.forEach(function(fpr){
      block.membersChanges.push('-' + fpr);
    });
    block.keysChanges = [];
    done(null, block);
  }

  /**
  * Generate a "newcomers" keyblock
  */
  this.generateUpdates = function (done) {
    async.waterfall([
      function (next){
        findUpdates(next);
      },
      function (updates, subupdates, next){
        KeyBlock.current(function (err, current) {
          next(null, current || null, updates, subupdates);
        });
      },
      function (current, updates, subupdates, next){
        createNewcomerBlock(current, null, {}, updates, subupdates, next);
      },
    ], done);
  }

  function findUpdates (done) {
    var updates = {};
    var subupdates = {};
    async.waterfall([
      function (next){
        Key.findMembersWithUpdates(next);
      },
      function (members, next){
        async.forEachSeries(members, function(member, callback){
          var fpr = member.fingerprint;
          async.waterfall([
            function (next){
              PublicKey.getTheOne(fpr, next);
            },
            function (pubkey, next){
              var key = pubkey.getKey();
              var finalPackets = new openpgp.packet.List();
              var certifs = pubkey.getCertificationsFromMD5List(member.certifs);
              var subkeys = pubkey.getSubkeysFromMD5List(member.subkeys);
              if (subkeys.length > 0) {
                subupdates[fpr] = subkeys;
              }
              async.forEachSeries(certifs, function(certif, callback){
                var issuerKeyId = certif.issuerKeyId.toHex().toUpperCase();
                async.waterfall([
                  function (next){
                    TrustedKey.getTheOne(issuerKeyId, next);
                  },
                  function (trusted, next){
                    // Issuer is a member
                    finalPackets.push(certif);
                    next();
                  },
                ], function (err) {
                  // Issuer is not a member
                  callback();
                });
              }, function(err){
                if (finalPackets.length > 0) {
                  updates[fpr] = finalPackets;
                }
                next();
              });
            },
          ], callback);
        }, next);
      },
    ], function (err) {
      done(err, updates, subupdates);
    });
  }

  /**
  this.generateNewcomers = function (done) {
  * Generate a "newcomers" keyblock
  */
  this.generateNewcomers = function (done) {
    var filteringFunc = function (preJoinData, next) {
      var joinData = {};
      var newcomers = _(preJoinData).keys();
      var uids = [];
      newcomers.forEach(function(newcomer){
        uids.push(preJoinData[newcomer].ms.userid);
      });
      if (newcomers.length > 0) {
        inquirer.prompt([{
          type: "checkbox",
          name: "uids",
          message: "Newcomers to add",
          choices: uids,
          default: uids[0]
        }], function (answers) {
          newcomers.forEach(function(newcomer){
            if (~answers.uids.indexOf(preJoinData[newcomer].ms.userid))
              joinData[newcomer] = preJoinData[newcomer];
          });
          if (answers.uids.length == 0)
            next('No newcomer selected');
          else
            next(null, joinData);
        });
      } else {
        next('No newcomer found');
      }
    };
    var checkingWoTFunc = function (newcomers, checkWoTForNewcomers, done) {
      checkWoTForNewcomers(newcomers, function (err) {
        // If success, simply add all newcomers. Otherwise, stop everything.
        done(err, newcomers);
      });
    };
    KeychainService.generateNewcomersBlock(filteringFunc, checkingWoTFunc, done);
  }

  /**
  this.generateNewcomers = function (done) {
  * Generate a "newcomers" keyblock
  */
  this.generateNewcomersAuto = function (done) {
    KeychainService.generateNewcomersBlock(noFiltering, iteratedChecking, done);
  }


  function noFiltering(preJoinData, next) {
    // No manual filtering, takes all
    next(null, preJoinData);
  }

  function iteratedChecking(newcomers, checkWoTForNewcomers, done) {
    var passingNewcomers = [];
    async.forEachSeries(newcomers, function(newcomer, callback){
      checkWoTForNewcomers(passingNewcomers.concat(newcomer), function (err) {
        // If success, add this newcomer to the valid newcomers. Otherwise, reject him.
        if (!err)
          passingNewcomers.push(newcomer);
        callback();
      });
    }, function(){
      done(null, passingNewcomers);
    });
  }

  this.generateNext = function (done) {
    KeychainService.generateNextBlock(findUpdates, noFiltering, iteratedChecking, done);
  };

  /**
  * Generate a "newcomers" keyblock
  */
  this.generateNewcomersBlock = function (filteringFunc, checkingWoTFunc, done) {
    var withoutUpdates = function(updates) { updates(null, {}, {}); };
    KeychainService.generateNextBlock(withoutUpdates, filteringFunc, checkingWoTFunc, done);
  };

  /**
  * Generate next keyblock, gathering both updates & newcomers
  */
  this.generateNextBlock = function (findUpdateFunc, filteringFunc, checkingWoTFunc, done) {
    var updates = {};
    var subupdates = {};
    async.waterfall([
      function (next) {
        // First, check for members' key updates
        findUpdateFunc(next);
      },
      function (theUpdates, theSubupdates, next) {
        updates = theUpdates;
        subupdates = theSubupdates;
        findNewcomers(filteringFunc, checkingWoTFunc, next);
      },
      function (current, newWoT, joinData, otherUpdates, next){
        // Merges updates
        _(otherUpdates).keys().forEach(function(fpr){
          if (!updates[fpr])
            updates[fpr] = otherUpdates[fpr];
          else
            updates[fpr].concat(otherUpdates[fpr]);
        });
        // Create the block
        createNewcomerBlock(current, newWoT, joinData, updates, subupdates, next);
      },
    ], done);
  };

  function findNewcomers (filteringFunc, checkingWoTFunc, done) {
    var wotMembers = [];
    var preJoinData = {};
    var joinData = {};
    var updates = {};
    var current;
    async.waterfall([
      function (next){
        // Second, check for newcomers
        KeyBlock.current(function (err, currentBlock) {
          current = currentBlock;
            next();
        });
      },
      function (next){
        Membership.find({ eligible: true }, next);
      },
      function (mss, next){
        async.forEach(mss, function(ms, callback){
          var join = { pubkey: null, ms: ms, key: null };
          async.waterfall([
            function (next){
              async.parallel({
                pubkey: function(callback){
                  PublicKey.getTheOne(join.ms.issuer, callback);
                },
                key: function(callback){
                  Key.getTheOne(join.ms.issuer, callback);
                },
              }, next);
            },
            function (res, next){
              var pubk = res.pubkey;
              join.pubkey = pubk;
              if (!res.key.eligible) {
                next('PublicKey of ' + uid + ' is not eligible');
                return;
              }
              var key = keyhelper.fromArmored(pubk.raw);
              join.key = key;
              // Just require a good udid2
              if (!key.hasValidUdid2()) {
                next('User ' + uid + ' does not have a valid udid2 userId');
                return;
              }
              preJoinData[join.pubkey.fingerprint] = join;
              next();
            },
          ], callback);
        }, next);
      },
      function (next){
        filteringFunc(preJoinData, next);
      },
      function (filteredJoinData, next) {
        joinData = filteredJoinData;
        // Cache the members
        Key.getMembers(next);
      },
      function (membersKeys, next) {
        membersKeys.forEach(function (mKey) {
          wotMembers.push(mKey.fingerprint);
        });
        // Look for signatures from newcomers to the WoT
        async.forEach(_(joinData).keys(), function(newcomer, searchedSignaturesOfTheWoT){
          findSignaturesFromNewcomerToWoT(newcomer, function (err, signatures) {
            _(signatures).keys().forEach(function(signedMember){
              updates[signedMember] = (updates[signedMember] || new openpgp.packet.List());
              updates[signedMember].concat(signatures[signedMember]);
            });
            searchedSignaturesOfTheWoT(err);
          });
        }, next);
      },
      function (next) {
        // Checking step
        var newcomers = _(joinData).keys();
        // Checking algo is defined by 'checkingWoTFunc'
        checkingWoTFunc(newcomers, function (theNewcomers, onceChecked) {
          // Concats the joining members
          var members = wotMembers.concat(theNewcomers);
          // Check WoT stability
          var membersChanges = [];
          var newLinks = computeNewLinks(theNewcomers, joinData, updates, members);
          theNewcomers.forEach(function (newcomer) {
            membersChanges.push('+' + newcomer);
          });
          checkWoTStability({ number: current ? current.number + 1 : 0, membersChanges: membersChanges }, newLinks, onceChecked);
        }, function (err, realNewcomers) {
          var newWoT = wotMembers.concat(realNewcomers);
          var newLinks = computeNewLinks(realNewcomers, joinData, updates, newWoT);
          next(err, realNewcomers, newLinks, newWoT);
        });
      },
      function (realNewcomers, newLinks, newWoT, next) {
        var finalJoinData = {};
        var initialNewcomers = _(joinData).keys();
        var nonKept = _(initialNewcomers).difference(realNewcomers);
        realNewcomers.forEach(function(newcomer){
          var data = joinData[newcomer];
          // Only keep newcomer signatures from members
          var keptCertifs = new openpgp.packet.List();
          data.key.getOtherCertifications().forEach(function(certif){
            var issuerKeyId = certif.issuerKeyId.toHex().toUpperCase();
            var fingerprint = matchFingerprint(issuerKeyId, newWoT);
            if (fingerprint && ~newLinks[data.key.getFingerprint()].indexOf(fingerprint)) {
              keptCertifs.push(certif);
            }
          });
          data.key.setOtherCertifications(keptCertifs);
          // Only keep membership of selected newcomers
          finalJoinData[newcomer] = data;
        });
        // Only keep update signatures from members
        _(updates).keys().forEach(function(signedFPR){
          var keptCertifs = new openpgp.packet.List();
          (updates[signedFPR] || new openpgp.packet.List()).forEach(function(certif){
            var issuerKeyId = certif.issuerKeyId.toHex().toUpperCase();
            var fingerprint = matchFingerprint(issuerKeyId, initialNewcomers);
            if (fingerprint && ~newWoT.indexOf(fingerprint) && ~newLinks[signedFPR].indexOf(fingerprint)) {
              keptCertifs.push(certif);
            }
          });
          updates[signedFPR] = keptCertifs;
        });
        // Send back the new WoT, the joining data and key updates for newcomers' signature of WoT
        next(null, current, wotMembers.concat(realNewcomers), finalJoinData, updates);
      }
    ], done);
  }

  function computeNewLinks (theNewcomers, joinData, updates, members) {
    var newLinks = {};
    // Cache new links from WoT => newcomer
    theNewcomers.forEach(function (newcomer) {
      newLinks[newcomer] = [];
      var certifs = joinData[newcomer].key.getOtherCertifications();
      certifs.forEach(function (certif) {
        var issuer = certif.issuerKeyId.toHex().toUpperCase();
        var matched = matchFingerprint(issuer, members);
        if (matched)
          newLinks[newcomer].push(matched);
      });
      // Cache new links from newcomer => WoT
      var newcomerKeyID = newcomer.substring(24);
      _(updates).keys().forEach(function(signedFPR){
        updates[signedFPR].forEach(function(certif){
          if (certif.issuerKeyId.toHex().toUpperCase() == newcomerKeyID) {
            newLinks[signedFPR] = (newLinks[signedFPR] || []);
            newLinks[signedFPR].push(newcomer);
          }
        });
      });
    });
    return newLinks;
  }

  function findSignaturesFromNewcomerToWoT (newcomer, done) {
    var updates = {};
    async.waterfall([
      function (next){
        Key.findMembersWhereSignatory(newcomer, next);
      },
      function (keys, next){
        async.forEach(keys, function(signedKey, extractedSignatures){
          async.waterfall([
            function (next){
              PublicKey.getTheOne(signedKey.fingerprint, next);
            },
            function (signedPubkey, next){
              var key = keyhelper.fromArmored(signedPubkey.raw);
              var certifs = key.getCertificationsFromSignatory(newcomer);
              if (certifs.length > 0) {
                updates[signedPubkey.fingerprint] = certifs;
                certifs.forEach(function(){
                  logger.debug('Found WoT certif %s --> %s', newcomer, signedPubkey.fingerprint);
                });
              }
              next();
            },
          ], function () {
            extractedSignatures();
          });
        }, function (err) {
          next(err, updates);
        });
      },
    ], done);
  }

  function matchFingerprint (keyID, fingerprints) {
    var matched = "";
    var i = 0;
    while (!matched && i < fingerprints.length) {
      if (fingerprints[i].match(new RegExp(keyID + '$')))
        matched = fingerprints[i];
      i++;
    }
    return matched;
  }

  function createNewcomerBlock (current, members, joinData, updates, subupdates, done) {
    var block = new KeyBlock();
    block.version = 1;
    block.currency = current ? current.currency : conf.currency;
    block.number = current ? current.number + 1 : 0;
    block.previousHash = current ? current.hash : "";
    block.previousIssuer = current ? current.issuer : "";
    // Members merkle
    if (members) {
      members.sort();
      var tree = merkle(members, 'sha1').process();
      block.membersCount = members.length;
      block.membersRoot = tree.root();
      block.membersChanges = [];
      _(joinData).keys().forEach(function(fpr){
        block.membersChanges.push('+' + fpr);
      });
    } else if (!members && current) {
      // No members changes
      block.membersCount = current.membersCount;
      block.membersRoot = current.membersRoot;
      block.membersChanges = [];
    } else {
      done('Wrong new block: cannot make a root block without members');
      return;
    }
    // Keychanges - newcomers
    block.keysChanges = [];
    _(joinData).values().forEach(function(join){
      var key = join.key;
      block.keysChanges.push({
        type: 'N',
        fingerprint: join.pubkey.fingerprint,
        keypackets: keyhelper.toEncoded(key.getFounderPackets()),
        certpackets: keyhelper.toEncoded(key.getOtherCertifications()),
        membership: {
          membership: join.ms.inlineValue(),
          signature: join.ms.inlineSignature()
        }
      });
    });
    // Keychanges - updates: signatures from newcomers
    var updateKeys = _(updates).keys();
    var subkeyKeys = _(subupdates).keys();
    var allUpdates = _(updateKeys.concat(subkeyKeys)).uniq();
    allUpdates.forEach(function(fpr){
      if ((updates[fpr] && updates[fpr].length > 0) || (subupdates[fpr] && subupdates[fpr].length > 0)) {
        block.keysChanges.push({
          type: 'U',
          fingerprint: fpr,
          keypackets: subupdates[fpr] ? base64.encode(subupdates[fpr].write()) : '',
          certpackets: updates[fpr] ? base64.encode(updates[fpr].write()) : '',
          membership: {}
        });
      }
    });
    done(null, block);
  }

  function checkCertificationOfKey (certif, certifiedFPR, newKeys, done) {
    var found = null;
    async.waterfall([
      function (next){
        var keyID = certif.issuerKeyId.toHex().toUpperCase();
        // Check in local newKeys for trusted key (if found, trusted is newcomer here)
        _(newKeys).keys().forEach(function(fpr){
          if (fpr.match(new RegExp(keyID + '$')))
            found = fpr;
        });
        async.parallel({
          pubkeyCertified: function(callback){
            if (newKeys[certifiedFPR]) {
              // The certified is a newcomer
              var key = newKeys[certifiedFPR];
              async.waterfall([
                function (next){
                  parsers.parsePubkey(next).asyncWrite(unix2dos(key.getArmored()), next);
                },
                function (obj, next) {
                  next(null, new PublicKey(obj));
                }
              ], callback);
            }
            // The certified is a WoT member
            else PublicKey.getTheOne(certifiedFPR, callback);
          },
          trusted: function(callback){
            if (found)
              callback(null, { fingerprint: found });
            else
              TrustedKey.getTheOne(keyID, callback);
          }
        }, next);
      },
      function (res, next){
        // Known certifier KeyID, get his public key + check if member
        var certifierFPR = res.trusted.fingerprint;
        async.parallel({
          pubkeyCertifier: function(callback){
            PublicKey.getTheOne(certifierFPR, callback);
          },
          isMember: function(callback){
            if (found) {
              // Is considered a member since valide newcomer
              callback(null, res);
              return;
            }
            Key.isMember(certifierFPR, function (err, isMember) {
              callback(err || (!isMember && 'Signature from non-member ' + res.trusted.fingerprint), res);
            });
          }
        }, function (err, res2) {
          res2.pubkeyCertified = res.pubkeyCertified;
          next(err, res2);
        });
      },
      function (res, next){
        var other = { pubkey: res.pubkeyCertifier };
        var uid = res.pubkeyCertified.getUserID();
        var selfKey = res.pubkeyCertified.getKey();
        var otherKey = other.pubkey.getKey();
        var userId = new openpgp.packet.Userid();
        logger.info('Signature for '+ uid);
        userId.read(uid);
        var success = certif.verify(otherKey.getPrimaryKey(), {userid: userId, key: selfKey.getPrimaryKey()});
        next(success ? null : 'Wrong signature', success && other.pubkey.fingerprint);
      },
    ], done);
  }

  this.computeDistances = function (done) {
    var current;
    async.waterfall([
      function (next) {
        KeyBlock.current(next);
      },
      function (currentBlock, next) {
        current = currentBlock;
        Link.unobsoletesAllLinks(next);
      },
      function (next) {
        Key.undistanceEveryKey(next);
      },
      function (next) {
        computeObsoleteLinks(current, next);
      }
    ], done);
  }

  this.prove = function (block, sigFunc, nbZeros, done) {
    var powRegexp = new RegExp('^0{' + nbZeros + '}');
    var pow = "", sig = "", raw = "";
    var start = new Date().timestamp();
    var testsCount = 0;
    logger.debug('Generating proof-of-work with %s leading zeros...', nbZeros);
    async.whilst(
      function(){ return !pow.match(powRegexp); },
      function (next) {
        var newTS = new Date().utcZero().timestamp();
        if (newTS == block.timestamp) {
          block.nonce++;
        } else {
          block.nonce = 0;
          block.timestamp = newTS;
        }
        raw = block.getRaw();
        sigFunc(raw, function (err, sigResult) {
          sig = unix2dos(sigResult);
          var full = raw + sig;
          pow = full.hash();
          testsCount++;
          if (testsCount % 100 == 0) {
            process.stdout.write('.');
          } else if (testsCount % 50 == 0) {
            if (newKeyblockCallback) {
              computationActivated = false
              next('New block received');
            }
          }
          next();
        });
      }, function (err) {
        if (err) {
          logger.debug('Proof-of-work computation canceled: valid block received');
          done(err);
          newKeyblockCallback();
          return;
        }
        block.signature = sig;
        var end = new Date().timestamp();
        var duration = moment.duration((end - start)) + 's';
        var testsPerSecond = (testsCount / (end - start)).toFixed(2);
        logger.debug('Done: ' + pow + ' in ' + duration + ' (~' + testsPerSecond + ' tests/s)');
        done(err, block);
      });
  };

  this.showKeychain = function (done) {
    async.waterfall([
      function (next){
        KeyBlock
          .find({})
          .sort({ number: 1 })
          .exec(next);
      },
      function (blocks, next){
        async.forEachSeries(blocks, function(block, callback){
          block.display(callback);
        }, next);
      },
    ], done);
  };

  this.startGeneration = function (done) {
    if (!conf.participate) return;
    if (!PeeringService) {
      done('Needed peering service activated.');
      return;
    }
    computationActivated = true;
    var sigFunc, block, difficulty;
    async.waterfall([
      function (next) {
        KeyBlock.current(function (err, current) {
          next(null, current);
        });
      },
      function (current, next){
        if (!current) {
          next(null, null);
          return;
        } else {
          async.parallel({
            block: function(callback){
              KeychainService.generateNext(callback);
            },
            signature: function(callback){
              signature(conf.pgpkey, conf.pgppasswd, conf.openpgpjs, callback);
            },
            trial: function (callback) {
              getTrialLevel(PeeringService.cert.fingerprint, current ? current.number + 1 : 0, current ? current.membersCount : 0, callback);
            }
          }, next);
        }
      },
      function (res, next){
        if (!res) {
          next(null, null, 'Waiting for a root block before computing new blocks');
        } else {
          KeychainService.prove(res.block, res.signature, res.trial, function (err, proofBlock) {
            next(null, proofBlock, err);
          });
        }
      },
    ], function (err, proofBlock, powCanceled) {
      if (powCanceled) {
        logger.warn(powCanceled);
        computeNextCallback = async.apply(done, null, null);
        computationActivated = false
      } else {
        computationActivated = false
        done(err, proofBlock);
      }
    });
  };
}
