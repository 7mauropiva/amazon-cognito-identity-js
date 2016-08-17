/**
 * Copyright 2016 Amazon.com,
 * Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Amazon Software License (the "License").
 * You may not use this file except in compliance with the
 * License. A copy of the License is located at
 *
 *     http://aws.amazon.com/asl/
 *
 * or in the "license" file accompanying this file. This file is
 * distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
 * CONDITIONS OF ANY KIND, express or implied. See the License
 * for the specific language governing permissions and
 * limitations under the License.
 */

import * as sjcl from 'sjcl';
import { BigInteger } from 'bn';

import * as AWSCognito from '../dist/aws-cognito-sdk';
import AuthenticationHelper from './AuthenticationHelper';
import CognitoAccessToken from './CognitoAccessToken';
import CognitoIdToken from './CognitoIdToken';
import CognitoRefreshToken from './CognitoRefreshToken';
import CognitoUserSession from './CognitoUserSession';
import DateHelper from './DateHelper';

export default class CognitoUser {
  /**
   * Constructs a new CognitoUser object
   * @param data
   * @constructor
   */

  constructor(data) {
    if (data == null || data.Username == null || data.Pool == null) {
      throw new Error('Username and pool information are required.');
    }

    this.username = data.Username || '';
    this.pool = data.Pool;
    this.Session = null;

    this.client = new AWSCognito.CognitoIdentityServiceProvider({ apiVersion: '2016-04-19' });

    this.signInUserSession = null;
    this.authenticationFlowType = 'USER_SRP_AUTH';
  }

  /**
   * Gets the current session for this user
   *
   * @returns {CognitoUserSession}
   */

  getSignInUserSession() {
    return this.signInUserSession;
  }

  /**
   * Returns the user's username
   * @returns {string}
   */

  getUsername() {
    return this.username;
  }

  /**
   * Returns the authentication flow type
   * @returns {String}
   */

  getAuthenticationFlowType() {
    return this.authenticationFlowType;
  }

  /**
   * sets authentication flow type
   * @param authenticationFlowType
   */

  setAuthenticationFlowType(authenticationFlowType) {
    this.authenticationFlowType = authenticationFlowType;
  }

  /**
   * This is used for authenticating the user. it calls the AuthenticationHelper for SRP related stuff
   * @param authentication details, contains the authentication data
   * @param callback
   * @returns {CognitoUserSession}
   */

  authenticateUser(authDetails, callback) {
    const authenticationHelper = new AuthenticationHelper(this.pool.getUserPoolId().split('_')[1], this.pool.getParanoia());
    const dateHelper = new DateHelper();

    let serverBValue;
    let salt;
    const self = this;
    const authParameters = {};

    if (this.deviceKey != null) {
      authParameters['DEVICE_KEY'] = this.deviceKey;
    }

    authParameters['USERNAME'] = this.username;
    authParameters['SRP_A'] = authenticationHelper.getLargeAValue().toString(16);

    if (this.authenticationFlowType === 'CUSTOM_AUTH') {
      authParameters['CHALLENGE_NAME'] = 'SRP_A';
    }

    this.client.makeUnauthenticatedRequest('initiateAuth', {
      AuthFlow: this.authenticationFlowType,
      ClientId: this.pool.getClientId(),
      AuthParameters: authParameters,
      ClientMetadata: authDetails.getValidationData(),
    }, function (err, data) {
      if (err) {
        return callback.onFailure(err);
      }

      const challengeParameters = data.ChallengeParameters;

      self.username = challengeParameters.USER_ID_FOR_SRP;
      serverBValue = new BigInteger(challengeParameters.SRP_B, 16);
      salt = new BigInteger(challengeParameters.SALT, 16);
      self.getCachedDeviceKeyAndPassword();

      const hkdf = authenticationHelper.getPasswordAuthenticationKey(self.username, authDetails.getPassword(), serverBValue, salt);
      const secretBlockBits = sjcl.codec.base64.toBits(challengeParameters.SECRET_BLOCK);

      const mac = new sjcl.misc.hmac(hkdf, sjcl.hash.sha256);
      mac.update(sjcl.codec.utf8String.toBits(self.pool.getUserPoolId().split('_')[1]));
      mac.update(sjcl.codec.utf8String.toBits(self.username));
      mac.update(secretBlockBits);
      const dateNow = dateHelper.getNowString();
      mac.update(sjcl.codec.utf8String.toBits(dateNow));
      const signature = mac.digest();
      const signatureString = sjcl.codec.base64.fromBits(signature);

      const challengeResponses = {};

      challengeResponses['USERNAME'] = self.username;
      challengeResponses['PASSWORD_CLAIM_SECRET_BLOCK'] = challengeParameters.SECRET_BLOCK;
      challengeResponses['TIMESTAMP'] = dateNow;
      challengeResponses['PASSWORD_CLAIM_SIGNATURE'] = signatureString;

      if (self.deviceKey != null) {
        challengeResponses['DEVICE_KEY'] = self.deviceKey;
      }

      self.client.makeUnauthenticatedRequest('respondToAuthChallenge', {
        ChallengeName: 'PASSWORD_VERIFIER',
        ClientId: self.pool.getClientId(),
        ChallengeResponses: challengeResponses,
        Session: data.Session,
      }, function (errAuthenticate, dataAuthenticate) {
        if (errAuthenticate) {
          return callback.onFailure(errAuthenticate);
        }

        const challengeName = dataAuthenticate.ChallengeName;
        if (challengeName != null && challengeName === 'SMS_MFA') {
          self.Session = dataAuthenticate.Session;
          return callback.mfaRequired(challengeName);
        } else if (challengeName != null && challengeName === 'CUSTOM_CHALLENGE') {
          self.Session = dataAuthenticate.Session;
          return callback.customChallenge(dataAuthenticate.ChallengeParameters);
        } else if (challengeName != null && challengeName === 'DEVICE_SRP_AUTH') {
          self.getDeviceResponse(callback);
        } else {
          self.signInUserSession = self.getCognitoUserSession(dataAuthenticate.AuthenticationResult);
          self.cacheTokens();

          if (dataAuthenticate.AuthenticationResult.NewDeviceMetadata != null) {
            const deviceStuff = authenticationHelper.generateHashDevice(dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceGroupKey, dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceKey);

            const deviceSecretVerifierConfig = {
              Salt: sjcl.codec.base64.fromBits(sjcl.codec.hex.toBits(authenticationHelper.getSaltDevices().toString(16))),
              PasswordVerifier: sjcl.codec.base64.fromBits(sjcl.codec.hex.toBits(authenticationHelper.getVerifierDevices().toString(16))),
            };

            self.verifierDevices = sjcl.codec.base64.fromBits(authenticationHelper.getVerifierDevices());
            self.deviceGroupKey = dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceGroupKey;
            self.randomPassword = authenticationHelper.getRandomPassword();

            self.client.makeUnauthenticatedRequest('confirmDevice', {
              DeviceKey: dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceKey,
              AccessToken: self.signInUserSession.getAccessToken().getJwtToken(),
              DeviceSecretVerifierConfig: deviceSecretVerifierConfig,
              DeviceName: navigator.userAgent,
            }, function (errConfirm, dataConfirm) {
              if (errConfirm) {
                return callback.onFailure(errConfirm);
              }
              self.deviceKey = dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceKey;
              self.cacheDeviceKeyAndPassword();
              if (dataConfirm.UserConfirmationNecessary === true) {
                return callback.onSuccess(self.signInUserSession, dataConfirm.UserConfirmationNecessary);
              } else {
                return callback.onSuccess(self.signInUserSession);
              }
            });
          } else {
            return callback.onSuccess(self.signInUserSession);
          }
        }
      });
    });
  }

  /**
   * This is used to get a session using device authentication. It is called at the end of user authentication
   *
   * @param callback
   * @response error or session
   */

  getDeviceResponse(callback) {
    const authenticationHelper = new AuthenticationHelper(this.deviceGroupKey, this.pool.getParanoia());
    const dateHelper = new DateHelper();

    const self = this;
    const authParameters = {};

    authParameters['USERNAME'] = this.username;
    authParameters['DEVICE_KEY'] = this.deviceKey;
    authParameters['SRP_A'] = authenticationHelper.getLargeAValue().toString(16);

    this.client.makeUnauthenticatedRequest('respondToAuthChallenge', {
      ChallengeName: 'DEVICE_SRP_AUTH',
      ClientId: this.pool.getClientId(),
      ChallengeResponses: authParameters,
    }, function (err, data) {
      if (err) {
        return callback.onFailure(err);
      }

      const challengeParameters = data.ChallengeParameters;

      const serverBValue = new BigInteger(challengeParameters.SRP_B, 16);
      const salt = new BigInteger(challengeParameters.SALT, 16);

      const hkdf = authenticationHelper.getPasswordAuthenticationKey(self.deviceKey, self.randomPassword, serverBValue, salt);
      const secretBlockBits = sjcl.codec.base64.toBits(challengeParameters.SECRET_BLOCK);

      const mac = new sjcl.misc.hmac(hkdf, sjcl.hash.sha256);
      mac.update(sjcl.codec.utf8String.toBits(self.deviceGroupKey));
      mac.update(sjcl.codec.utf8String.toBits(self.deviceKey));
      mac.update(secretBlockBits);
      const dateNow = dateHelper.getNowString();
      mac.update(sjcl.codec.utf8String.toBits(dateNow));
      const signature = mac.digest();
      const signatureString = sjcl.codec.base64.fromBits(signature);

      const challengeResponses = {};

      challengeResponses['USERNAME'] = self.username;
      challengeResponses['PASSWORD_CLAIM_SECRET_BLOCK'] = challengeParameters.SECRET_BLOCK;
      challengeResponses['TIMESTAMP'] = dateNow;
      challengeResponses['PASSWORD_CLAIM_SIGNATURE'] = signatureString;
      challengeResponses['DEVICE_KEY'] = self.deviceKey;

      self.client.makeUnauthenticatedRequest('respondToAuthChallenge', {
        ChallengeName: 'DEVICE_PASSWORD_VERIFIER',
        ClientId: self.pool.getClientId(),
        ChallengeResponses: challengeResponses,
        Session: data.Session,
      }, function (errAuthenticate, dataAuthenticate) {
        if (errAuthenticate) {
          return callback.onFailure(errAuthenticate);
        }

        self.signInUserSession = self.getCognitoUserSession(dataAuthenticate.AuthenticationResult);
        self.cacheTokens();

        return callback.onSuccess(self.signInUserSession);
      });
    });
  };

  /**
   * This is used for a certain user to confirm the registration by using a confirmation code
   * @param confirmationCode
   * @param forceAliasCreation
   * @param callback
   * @returns error or success
   */

  confirmRegistration(confirmationCode, forceAliasCreation, callback) {
    this.client.makeUnauthenticatedRequest('confirmSignUp', {
      ClientId: this.pool.getClientId(),
      ConfirmationCode: confirmationCode,
      Username: this.username,
      ForceAliasCreation: forceAliasCreation,
    }, function (err, data) {
      if (err) {
        return callback(err, null);
      } else {
        return callback(null, 'SUCCESS');
      }
    });
  }

  /**
   * This is used by the user once he has the responses to a custom challenge
   * @param answerChallenge
   * @param callback
   * @returns {CognitoUserSession}
   */

  sendCustomChallengeAnswer(answerChallenge, callback) {
    const challengeResponses = {};
    challengeResponses['USERNAME'] = this.username;
    challengeResponses['ANSWER'] = answerChallenge;

    const self = this;
    this.client.makeUnauthenticatedRequest('respondToAuthChallenge', {
      ChallengeName: 'CUSTOM_CHALLENGE',
      ChallengeResponses: challengeResponses,
      ClientId: this.pool.getClientId(),
      Session: this.Session,
    }, function (err, data) {
      if (err) {
        return callback.onFailure(err);
      } else {
        const challengeName = data.ChallengeName;

        if (challengeName != null && challengeName === 'CUSTOM_CHALLENGE') {
          self.Session = data.Session;
          return callback.customChallenge(data.challengeParameters);
        } else {
          self.signInUserSession = self.getCognitoUserSession(data.AuthenticationResult);
          self.cacheTokens();
          return callback.onSuccess(self.signInUserSession);
        }
      }
    });
  };

  /**
   * This is used by the user once he has an MFA code
   * @param confirmationCode
   * @param callback
   * @returns {CognitoUserSession}
   */

  sendMFACode(confirmationCode, callback) {
    const challengeResponses = {};
    challengeResponses['USERNAME'] = this.username;
    challengeResponses['SMS_MFA_CODE'] = confirmationCode;

    if (this.deviceKey != null) {
      challengeResponses['DEVICE_KEY'] = this.deviceKey;
    }

    const self = this;
    this.client.makeUnauthenticatedRequest('respondToAuthChallenge', {
      ChallengeName: 'SMS_MFA',
      ChallengeResponses: challengeResponses,
      ClientId: this.pool.getClientId(),
      Session: self.Session,
    }, function (err, dataAuthenticate) {
      if (err) {
        return callback.onFailure(err);
      } else {
        self.signInUserSession = self.getCognitoUserSession(dataAuthenticate.AuthenticationResult);
        self.cacheTokens();

        if (dataAuthenticate.AuthenticationResult.NewDeviceMetadata != null) {
          const authenticationHelper = new AuthenticationHelper(self.pool.getUserPoolId().split('_')[1], self.pool.getParanoia());
          const deviceStuff = authenticationHelper.generateHashDevice(dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceGroupKey, dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceKey);

          const deviceSecretVerifierConfig = {
            Salt: sjcl.codec.base64.fromBits(sjcl.codec.hex.toBits(authenticationHelper.getSaltDevices().toString(16))),
            PasswordVerifier: sjcl.codec.base64.fromBits(sjcl.codec.hex.toBits(authenticationHelper.getVerifierDevices().toString(16))),
          };

          self.verifierDevices = sjcl.codec.base64.fromBits(authenticationHelper.getVerifierDevices());
          self.deviceGroupKey = dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceGroupKey;
          self.randomPassword = authenticationHelper.getRandomPassword();

          self.client.makeUnauthenticatedRequest('confirmDevice', {
            DeviceKey: dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceKey,
            AccessToken: self.signInUserSession.getAccessToken().getJwtToken(),
            DeviceSecretVerifierConfig: deviceSecretVerifierConfig,
            DeviceName: navigator.userAgent,
          }, function (errConfirm, dataConfirm) {
            if (errConfirm) {
              return callback.onFailure(errConfirm);
            }
            self.deviceKey = dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceKey;
            self.cacheDeviceKeyAndPassword();
            if (dataConfirm.UserConfirmationNecessary === true) {
              return callback.onSuccess(self.signInUserSession, dataConfirm.UserConfirmationNecessary);
            } else {
              return callback.onSuccess(self.signInUserSession);
            }
          });
        } else {
          return callback.onSuccess(self.signInUserSession);
        }
      }
    });
  }

  /**
   * This is used by an authenticated user to change the current password
   * @param oldUserPassword
   * @param newUserPassword
   * @param callback
   * @returns error or success
   */

  changePassword(oldUserPassword, newUserPassword, callback) {
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      this.client.makeUnauthenticatedRequest('changePassword', {
        PreviousPassword: oldUserPassword,
        ProposedPassword: newUserPassword,
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, function (err, data) {
        if (err) {
          return callback(err, null);
        } else {
          return callback(null, 'SUCCESS');
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }

  /**
   * This is used by an authenticated user to enable MFA for himself
   * @param callback
   * @returns error or success
   */

  enableMFA(callback) {
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      const mfaOptions = [];
      const mfaEnabled = {
        DeliveryMedium: 'SMS',
        AttributeName: 'phone_number',
      };
      mfaOptions.push(mfaEnabled);

      this.client.makeUnauthenticatedRequest('setUserSettings', {
        MFAOptions: mfaOptions,
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, function (err, data) {
        if (err) {
          return callback(err, null);
        } else {
          return callback(null, 'SUCCESS');
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }

  /**
   * This is used by an authenticated user to disable MFA for himself
   * @param callback
   * @returns error or success
   */

  disableMFA(callback) {
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      const mfaOptions = [];

      this.client.makeUnauthenticatedRequest('setUserSettings', {
        MFAOptions: mfaOptions,
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, function (err, data) {
        if (err) {
          return callback(err, null);
        } else {
          return callback(null, 'SUCCESS');
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }


  /**
   * This is used by an authenticated user to delete himself
   * @param callback
   * @returns error or success
   */

  deleteUser(callback) {
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      this.client.makeUnauthenticatedRequest('deleteUser', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, function (err, data) {
        if (err) {
          return callback(err, null);
        } else {
          return callback(null, 'SUCCESS');
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }

  /**
   * This is used by an authenticated user to change a list of attributes
   * @param attributes
   * @param callback
   * @returns error or success
   */

  updateAttributes(attributes, callback) {
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      this.client.makeUnauthenticatedRequest('updateUserAttributes', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
        UserAttributes: attributes,
      }, function (err, dataUpdateAttributes) {
        if (err) {
          return callback(err, null);
        } else {
          return callback(null, 'SUCCESS');
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }

  /**
   * This is used by an authenticated user to get a list of attributes
   * @param callback
   * @returns error or success
   */

  getUserAttributes(callback) {
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      this.client.makeUnauthenticatedRequest('getUser', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, function (err, userData) {
        if (err) {
          return callback(err, null);
        } else {
          const attributeList = [];

          for (let i = 0; i < userData.UserAttributes.length; i++) {
            const attribute = {
              Name: userData.UserAttributes[i].Name,
              Value: userData.UserAttributes[i].Value,
            };
            const userAttribute = new CognitoUserAttribute(attribute);
            attributeList.push(userAttribute);
          }

          return callback(null, attributeList);
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }

  /**
   * This is used by an authenticated user to delete a list of attributes
   * @param attributeList
   * @param callback
   * @returns error or success
   */

  deleteAttributes(attributeList, callback) {
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      this.client.makeUnauthenticatedRequest('deleteUserAttributes', {
        UserAttributeNames: attributeList,
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, function (err, userData) {
        if (err) {
          return callback(err, null);
        } else {
          return callback(null, 'SUCCESS');
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }

  /**
   * This is used by a user to resend a confirmation code
   * @param callback
   * @returns error or success
   */

  resendConfirmationCode(callback) {
    this.client.makeUnauthenticatedRequest('resendConfirmationCode', {
      ClientId: this.pool.getClientId(),
      Username: this.username,
    }, function (err, data) {
      if (err) {
        return callback(err, null);
      } else {
        return callback(null, 'SUCCESS');
      }
    });
  }

  /**
   * This is used to get a session, either from the session object
   * or from  the local storage, or by using a refresh token
   *
   * @param callback
   * @returns error or session
   */

  getSession(callback) {
    if (this.username == null) {
      return callback(new Error('Username is null. Cannot retrieve a new session'), null);
    }

    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      return callback(null, this.signInUserSession);
    }

    const idTokenKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.idToken';
    const accessTokenKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.accessToken';
    const refreshTokenKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.refreshToken';

    const storage = window.localStorage;

    if (storage.getItem(idTokenKey)) {
      const idToken = new CognitoIdToken({ IdToken: storage.getItem(idTokenKey) });
      const accessToken = new CognitoAccessToken({ AccessToken: storage.getItem(accessTokenKey) });
      const refreshToken = new CognitoRefreshToken({ RefreshToken: storage.getItem(refreshTokenKey) });

      const sessionData = {
        IdToken: idToken,
        AccessToken: accessToken,
        RefreshToken: refreshToken,
      };
      const cachedSession = new CognitoUserSession(sessionData);
      if (cachedSession.isValid()) {
        this.signInUserSession = cachedSession;
        return callback(null, this.signInUserSession);
      } else {
        if (refreshToken.getToken() != null) {
          this.refreshSession(refreshToken, callback);
        } else {
          return callback(new Error('Cannot retrieve a new session. Please authenticate.'), null);
        }
      }
    }
  }


  /**
   * This uses the refreshToken to retrieve a new session
   * @param refreshToken
   * @param callback
   * @returns error or new session
   */

  refreshSession(refreshToken, callback) {
    const authParameters = {};
    authParameters['REFRESH_TOKEN'] = refreshToken.getToken();
    const lastUserKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.LastAuthUser';
    const storage = window.localStorage;

    if (storage.getItem(lastUserKey)) {
      this.username = storage.getItem(lastUserKey);
      const deviceKeyKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.deviceKey';
      this.deviceKey = storage.getItem(deviceKeyKey);
      authParameters['DEVICE_KEY'] = this.deviceKey;
    }

    const self = this;
    this.client.makeUnauthenticatedRequest('initiateAuth', {
      ClientId: this.pool.getClientId(),
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: authParameters,
    }, function (err, authResult) {
      if (err) {
        return callback(err, null);
      }
      if (authResult) {
        if (!authResult.AuthenticationResult.hasOwnProperty('RefreshToken')) {
          authResult.AuthenticationResult.RefreshToken = refreshToken.getToken();
        }
        self.signInUserSession = self.getCognitoUserSession(authResult.AuthenticationResult);
        self.cacheTokens();
        return callback(null, self.signInUserSession);
      }
    });
  }

  /**
   * This is used to save the session tokens to local storage
   */

  cacheTokens() {
    const idTokenKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.idToken';
    const accessTokenKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.accessToken';
    const refreshTokenKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.refreshToken';
    const lastUserKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.LastAuthUser';

    const storage = window.localStorage;

    storage.setItem(idTokenKey, this.signInUserSession.getIdToken().getJwtToken());
    storage.setItem(accessTokenKey, this.signInUserSession.getAccessToken().getJwtToken());
    storage.setItem(refreshTokenKey, this.signInUserSession.getRefreshToken().getToken());
    storage.setItem(lastUserKey, this.username);
  }

  /**
   * This is used to cache the device key and device group and device password
   */

  cacheDeviceKeyAndPassword() {
    const deviceKeyKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.deviceKey';
    const randomPasswordKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.randomPasswordKey';
    const deviceGroupKeyKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.deviceGroupKey';

    const storage = window.localStorage;

    storage.setItem(deviceKeyKey, this.deviceKey);
    storage.setItem(randomPasswordKey, this.randomPassword);
    storage.setItem(deviceGroupKeyKey, this.deviceGroupKey);
  }

  /**
   * This is used to get current device key and device group and device password
   */

  getCachedDeviceKeyAndPassword() {
    const deviceKeyKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.deviceKey';
    const randomPasswordKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.randomPasswordKey';
    const deviceGroupKeyKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.deviceGroupKey';

    const storage = window.localStorage;

    if (storage.getItem(deviceKeyKey)) {
      this.deviceKey = storage.getItem(deviceKeyKey);
      this.randomPassword = storage.getItem(randomPasswordKey);
      this.deviceGroupKey = storage.getItem(deviceGroupKeyKey);
    }
  }

  /**
   * This is used to clear the device key info from local storage
   */

  clearCachedDeviceKeyAndPassword() {
    const deviceKeyKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.deviceKey';
    const randomPasswordKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.randomPasswordKey';
    const deviceGroupKeyKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.deviceGroupKey';

    const storage = window.localStorage;

    storage.removeItem(deviceKeyKey);
    storage.removeItem(randomPasswordKey);
    storage.removeItem(deviceGroupKeyKey);
  }

  /**
   * This is used to clear the session tokens from local storage
   */

  clearCachedTokens() {
    const idTokenKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.idToken';
    const accessTokenKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.accessToken';
    const refreshTokenKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.' + this.username + '.refreshToken';
    const lastUserKey = 'CognitoIdentityServiceProvider.' + this.pool.getClientId() + '.LastAuthUser';

    const storage = window.localStorage;

    storage.removeItem(idTokenKey);
    storage.removeItem(accessTokenKey);
    storage.removeItem(refreshTokenKey);
    storage.removeItem(lastUserKey);
  }

  /**
   * This is used to build a user session from tokens retrieved in the authentication result
   * @param authResult
   *
   */

  getCognitoUserSession(authResult) {
    const idToken = new CognitoIdToken(authResult);
    const accessToken = new CognitoAccessToken(authResult);
    const refreshToken = new CognitoRefreshToken(authResult);

    const sessionData = {
      IdToken: idToken,
      AccessToken: accessToken,
      RefreshToken: refreshToken,
    };

    return new CognitoUserSession(sessionData);
  }

  /**
   * This is used to initiate a forgot password request
   * @param callback
   * @returns error or success
   *
   */

  forgotPassword(callback) {
    this.client.makeUnauthenticatedRequest('forgotPassword', {
      ClientId: this.pool.getClientId(),
      Username: this.username,
    }, function (err, data) {
      if (err) {
        return callback.onFailure(err);
      } else {
        if (typeof callback.inputVerificationCode === 'function') {
          return callback.inputVerificationCode(data);
        } else {
          return callback.onSuccess();
        }
      }
    });
  }

  /**
   * This is used to confirm a new password using a confirmationCode
   * @param confirmationCode
   * @param newPassword
   * @param callback
   * @returns error or success
   *
   */

  confirmPassword(confirmationCode, newPassword, callback) {
    this.client.makeUnauthenticatedRequest('confirmForgotPassword', {
      ClientId: this.pool.getClientId(),
      Username: this.username,
      ConfirmationCode: confirmationCode,
      Password: newPassword,
    }, function (err, data) {
      if (err) {
        return callback.onFailure(err);
      } else {
        return callback.onSuccess();
      }
    });
  }

  /**
   * This is used to initiate an attribute confirmation request
   * @param attributeName
   * @param callback
   * @returns error or success
   *
   */

  getAttributeVerificationCode(attributeName, callback) {
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      this.client.makeUnauthenticatedRequest('getUserAttributeVerificationCode', {
        AttributeName: attributeName,
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, function (err, data) {
        if (err) {
          return callback.onFailure(err);
        } else {
          return callback.inputVerificationCode(data);
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }

  /**
   * This is used to confirm an attribute using a confirmation code
   * @param confirmationCode
   * @param attributeName
   * @param callback
   * @returns error or success
   *
   */

  verifyAttribute(attributeName, confirmationCode, callback) {
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      this.client.makeUnauthenticatedRequest('verifyUserAttribute', {
        AttributeName: attributeName,
        Code: confirmationCode,
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, function (err, data) {
        if (err) {
          return callback.onFailure(err);
        } else {
          return callback.onSuccess('SUCCESS');
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }


  /**
   * This is used to get the device information using the current device key
   *
   * @param callback
   * @returns error or current device data
   */

  getDevice(callback) {
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      this.client.makeUnauthenticatedRequest('getDevice', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
        DeviceKey: this.deviceKey,
      }, function (err, data) {
        if (err) {
          return callback.onFailure(err);
        } else {
          return callback.onSuccess(data);
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }

  /**
   * This is used to forget the current device
   *
   * @param callback
   * @returns error or SUCCESS
   */

  forgetDevice(callback) {
    const self = this;
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      this.client.makeUnauthenticatedRequest('forgetDevice', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
        DeviceKey: this.deviceKey,
      }, function (err, data) {
        if (err) {
          return callback.onFailure(err);
        } else {
          self.deviceKey = null;
          self.deviceGroupkey = null;
          self.randomPassword = null;
          self.clearCachedDeviceKeyAndPassword();
          return callback.onSuccess('SUCCESS');
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }

  /**
   * This is used to set the device status as remembered
   *
   * @param callback
   * @returns error or SUCCESS
   */

  setDeviceStatusRemembered(callback) {
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      this.client.makeUnauthenticatedRequest('updateDeviceStatus', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
        DeviceKey: this.deviceKey,
        DeviceRememberedStatus: 'remembered',
      }, function (err, data) {
        if (err) {
          return callback.onFailure(err);
        } else {
          return callback.onSuccess('SUCCESS');
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }

  /**
   * This is used to set the device status as not remembered
   *
   * @param callback
   * @returns error or SUCCESS
   */

  setDeviceStatusNotRemembered(callback) {
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      this.client.makeUnauthenticatedRequest('updateDeviceStatus', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
        DeviceKey: this.deviceKey,
        DeviceRememberedStatus: 'not_remembered',
      }, function (err, data) {
        if (err) {
          return callback.onFailure(err);
        } else {
          return callback.onSuccess('SUCCESS');
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }

  /**
   * This is used to list all devices for a user
   *
   * @param limit the number of devices returned in a call
   * @param paginationToken the pagination token in case any was returned before
   * @param callback
   * @returns error or device data and pagination token
   */

  listDevices(limit, paginationToken, callback) {
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      this.client.makeUnauthenticatedRequest('listDevices', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
        Limit: limit,
        PaginationToken: paginationToken,
      }, function (err, data) {
        if (err) {
          return callback.onFailure(err);
        } else {
          return callback.onSuccess(data);
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }

  /**
   * This is used to globally revoke all tokens issued to a user
   *
   * @param callback
   * @returns error or SUCCESS
   */

  globalSignOut(callback) {
    const self = this;
    if (this.signInUserSession != null && this.signInUserSession.isValid()) {
      this.client.makeUnauthenticatedRequest('globalSignOut', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, function (err, data) {
        if (err) {
          return callback.onFailure(err);
        } else {
          self.clearCachedTokens();
          return callback.onSuccess('SUCCESS');
        }
      });
    } else {
      return callback(new Error('User is not authenticated'), null);
    }
  }

  /**
   * This is used for the user to signOut of the application and clear the cached tokens.
   *
   */

  signOut() {
    this.signInUserSession = null;
    this.clearCachedTokens();
  }
}
