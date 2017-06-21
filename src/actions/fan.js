// @flow
import R from 'ramda';
import platform from 'platform';
import { toastr } from 'react-redux-toastr';
import { validateUser } from './auth';
import firebase from '../services/firebase';
import {
  setBroadcastEvent,
  setBroadcastState,
  updateParticipants,
  setBroadcastEventStatus,
  setBackstageConnected,
  startPrivateCall,
  endPrivateCall,
  setReconnecting,
  setReconnected,
  setDisconnected,
} from './broadcast';
import { setInfo, resetAlert, setBlockUserAlert } from './alert';
import opentok from '../services/opentok';
import takeSnapshot from '../services/snapshot';
import networkTest from '../services/networkQuality';
import { getEventWithCredentials } from '../services/api';

const { changeVolume, toggleLocalAudio, toggleLocalVideo } = opentok;

const setFanStatus: ActionCreator = (status: FanStatus): FanAction => ({
  type: 'SET_FAN_STATUS',
  status,
});

const setFanName: ActionCreator = (fanName: string): FanAction => ({
  type: 'SET_FAN_NAME',
  fanName,
});

const setAbleToJoin: ActionCreator = (ableToJoin: boolean): FanAction => ({
  type: 'SET_ABLE_TO_JOIN',
  ableToJoin,
});

const createSnapshot = async (publisher: Publisher): ImgData => {
  try {
    const fanSnapshot = await takeSnapshot(publisher.getImgData()); // $FlowFixMe @TODO: resolve flow error
    return fanSnapshot;
  } catch (error) {
    console.log('Failed to create fan snapshot'); // $FlowFixMe @TODO: resolve flow error
    return null;
  }
};


const receivedChatMessage: ThunkActionCreator = (connection: Connection, message: ChatMessage): Thunk =>
  (dispatch: Dispatch, getState: GetState) => {
    const chatId = 'producer';
    const state = getState();
    const existingChat = R.pathOr(null, ['broadcast', 'chats', chatId], state);
    const fanType = (): ChatUser => {
      const status: FanStatus = R.path(['fan', 'fanStatus'], state);
      switch (status) {
        case 'inLine':
          return 'activeFan';
        case 'backstage':
          return 'backstageFan';
        case 'stage':
          return 'fan';
        default:
          return 'activeFan';
      }
    };
    const fromId = firebase.auth().currentUser.uid;
    const actions = [
      ({ type: 'START_NEW_PRODUCER_CHAT', fromType: fanType(), fromId, producer: { connection } }),
      ({ type: 'NEW_CHAT_MESSAGE', chatId, message: R.assoc('isMe', false, message) }),
    ];
    R.forEach(dispatch, existingChat ? R.tail(actions) : actions);
  };

const removeActiveFanRecord: ThunkActionCreator = (event: BroadcastEvent): Thunk =>
  async (): AsyncVoid => {
    const fanId = firebase.auth().currentUser.uid;
    const { fanUrl, adminId } = event;
    const record = {
      id: fanId,
    };
    const ref = firebase.database().ref(`activeBroadcasts/${adminId}/${fanUrl}/activeFans/${fanId}`);
    try {
      ref.set(record);
    } catch (error) {
      console.log('Failed to remove active fan record: ', error);
    }
  };

const leaveTheLine: ThunkActionCreator = (): Thunk =>
  async (dispatch: Dispatch, getState: GetState): AsyncVoid => {
    const state = getState();
    const event = R.path(['broadcast', 'event'], state);
    const isLive = R.equals('live', event.status);
    const fanOnStage = R.equals('stage', R.path(['fan', 'status'], state));
    await opentok.disconnectFromInstance('backstage');
    if (fanOnStage) await isLive ? opentok.unpublish('stage') : opentok.endCall('stage');
    dispatch(setBackstageConnected(false));
    dispatch(removeActiveFanRecord(event));
    dispatch(setFanStatus('disconnected'));

  };

const onSignal = (dispatch: Dispatch, getState: GetState): SignalListener =>
  async ({ type, data, from }: Signal): AsyncVoid => {
    const { fan } = getState();
    const signalData = data ? JSON.parse(data) : {};
    const signalType = R.last(R.split(':', type));
    const fromData = JSON.parse(from.data);
    const fromProducer = fromData.userType === 'producer';
    const isStage = R.equals(R.prop('status', fan), 'stage');
    const fanType = isStage ? 'fan' : 'backstageFan';
    const instance = isStage ? 'stage' : 'backstage';
    /* If the sender of this signal is not the Producer, we should do nothing */
    if (!fromProducer) return;
    switch (signalType) {
      case 'goLive':
        dispatch(setBroadcastEventStatus('live'));
        opentok.subscribeAll('stage');
        break;
      case 'videoOnOff':
        toggleLocalVideo(instance, signalData.video === 'on');
        break;
      case 'muteAudio':
        toggleLocalAudio(instance, signalData.mute === 'off');
        break;
      case 'changeVolume':
        changeVolume('stage', signalData.userType, signalData.volume);
        break;
      case 'chatMessage':
        dispatch(receivedChatMessage(from, signalData));
        break;
      case 'privateCall':
        fromProducer && dispatch(startPrivateCall(signalData.callWith, R.equals(signalData.callWith, fanType)));
        break;
      case 'endPrivateCall':
        fromProducer && dispatch(endPrivateCall(fanType));
        break;
      case 'openChat': // @TODO
      case 'finishEvent':
        dispatch(setBroadcastEventStatus('closed'));
        break;
      case 'joinBackstage':
        dispatch(setFanStatus('backstage'));
        break;
      case 'disconnectBackstage':
        dispatch(setFanStatus('inLine'));
        break;
      case 'disconnect':
        {
          dispatch(leaveTheLine());
          const message =
            `Thank you for participating, you are no longer sharing video/voice.
            You can continue to watch the session at your leisure.'`;
          toastr.success(message, { showCloseButton: false });
          break;
        }
      case 'joinHost':
        {
          /* Unpublish from backstage */
          await opentok.endCall('backstage');
          /* Display the going live alert */
          const options = (): AlertPartialOptions => ({
            title: '<h5>GOING LIVE NOW</h5>',
            text: '<h1><i class="fa fa-spinner fa-pulse"></i></h1>',
            showConfirmButton: false,
            html: true,
            type: null,
            allowEscapeKey: false,
          });
          dispatch(setInfo(options()));
          break;
        }
      case 'joinHostNow':
        {
          /* Change the status of the fan to 'stage' */
          dispatch(setFanStatus('stage'));
          /* Close the alert */
          dispatch(resetAlert());
          /* Start publishing to onstage */
          opentok.startCall('stage');
          /* Start subscribing from onstage */
          opentok.subscribeAll('stage');
          break;
        }
      default:
        break;
    }
  };

/**
 * Build the configuration options for the opentok service
 */
const opentokConfig = (userCredentials: UserCredentials, dispatch: Dispatch, getState: GetState): CoreInstanceOptions[] => {

  const broadcast = R.defaultTo({})(R.prop('broadcast', getState));
  // Set common listeners for all user types here
  const eventListeners: CoreInstanceListener = (instance: Core) => {

    // Assign listener for state changes
    const subscribeEvents: SubscribeEventType[] = ['subscribeToCamera', 'unsubscribeFromCamera'];
    const handleSubscribeEvent = (state: CoreState): void => dispatch(setBroadcastState(state));
    R.forEach((event: SubscribeEventType): void => instance.on(event, handleSubscribeEvent), subscribeEvents);

    // Assign listener for stream changes
    const otStreamEvents: StreamEventType[] = ['streamCreated', 'streamDestroyed'];
    const handleStreamEvent: StreamEventHandler = ({ type, stream }: OTStreamEvent) => {
      const isStage = R.propEq('name', 'stage', instance);
      const { userType } = JSON.parse(stream.connection.data);
      const state = getState();
      const isLive = R.equals('live', R.path(['broadcast', 'event', 'status'], state));
      const fanOnStage = R.equals('stage', R.path(['fan', 'status'], state));
      const userHasJoined = R.equals(type, 'streamCreated');
      const postProduction = R.path(['fan', 'postProduction'], state);
      const subscribeToAudio = !postProduction || R.equals('fan', userType);
      const options = { subscribeToAudio };
      const subscribeStage = (isLive || fanOnStage || postProduction) && userHasJoined && isStage;
      const subscribeBackStage = R.equals('producer', userType) && !isStage;
      subscribeStage && opentok.subscribe('stage', stream, options);
      // Subscribe to producer audio for private call
      subscribeBackStage && opentok.subscribe('backstage', stream);
      if (isStage) {
        dispatch(updateParticipants(userType, type, stream));
      }
    };

    R.forEach((event: StreamEventType): void => instance.on(event, handleStreamEvent), otStreamEvents);

    // Assign signal listener
    instance.on('signal', onSignal(dispatch, getState));

    // Assign reconnection event listeners
    instance.on('sessionReconnecting', (): void => dispatch(setReconnecting()));
    instance.on('sessionReconnected', (): void => dispatch(setReconnected()));
    instance.on('sessionDisconnected', (): void => dispatch(setDisconnected()));
  };

  const coreOptions = (name: string, credentials: SessionCredentials, publisherRole: UserRole, autoSubscribe: boolean = true): CoreOptions => ({
    name,
    credentials,
    streamContainers(pubSub: PubSub, source: VideoType, data: { userType: UserRole }): string {
      return `#video${pubSub === 'subscriber' ? data.userType : publisherRole}`;
    },
    communication: {
      autoSubscribe,
      callProperties: {
        fitMode: 'contain',
      },
    },
    controlsContainer: null,
  });

  const stage = (): CoreInstanceOptions => {
    const { apiKey, stageSessionId, stageToken } = userCredentials;
    const credentials = {
      apiKey,
      sessionId: stageSessionId,
      token: stageToken,
    };
    const isBroadcastLive: boolean = R.propEq('status', 'live', broadcast);
    const autoPublish: boolean = false;
    const autoSubscribe: boolean = isBroadcastLive;
    return {
      name: 'stage',
      coreOptions: coreOptions('stage', credentials, 'fan', autoSubscribe),
      eventListeners,
      opentokOptions: { autoPublish },
    };
  };

  const backstage = (): CoreInstanceOptions => {
    const { apiKey, sessionId, backstageToken } = userCredentials;
    const credentials = {
      apiKey,
      sessionId,
      token: backstageToken,
    };
    const autoPublish: boolean = true;
    return {
      name: 'backstage',
      coreOptions: coreOptions('backstage', credentials, 'backstageFan', false),
      eventListeners,
      opentokOptions: { autoPublish },
    };
  };

  return [stage(), backstage()];

};

/**
 * Connect to OpenTok sessions
 */
const connectToInteractive: ThunkActionCreator = (userCredentials: UserCredentials): Thunk =>
  async (dispatch: Dispatch, getState: GetState): AsyncVoid => {
    const instances: CoreInstanceOptions[] = opentokConfig(userCredentials, dispatch, getState);
    opentok.init(instances);
    await opentok.connect(['stage']);
    dispatch(setBroadcastState(opentok.state('stage')));
  };

/**
 * Start checking and reporting the network quality of the fan every 15 seconds
 */
const setupNetworkTest = async (fanId: UserId, adminId: UserId, fanUrl: string): AsyncVoid => {
  try {
    // Get an existing host or celebrity subscriber object
    const hostOrCelebSubscriber = (): TestSubscriber | void => {
      const coreState = opentok.state('stage');
      const isHostOrCeleb = ({ stream }: { stream: Stream }): boolean => {
        const { userType } = JSON.parse(R.pathOr(null, ['connection', 'data'], stream));
        return R.contains(userType, ['host', 'celebrity']);
      };
      return R.find(isHostOrCeleb, R.values(coreState.subscribers.camera));
    };
    // Use an available subscriber or create a new test subscriber
    const getSubscriber = async (): Promise<TestSubscriber> => hostOrCelebSubscriber() || opentok.createTestSubscriber('backstage');

    let subscriber: TestSubscriber = await getSubscriber();
    const updateNetworkQuality = async (): AsyncVoid => {
      const ref = firebase.database().ref(`activeBroadcasts/${adminId}/${fanUrl}/activeFans/${fanId}`);
      const networkQuality: QualityRating => NetworkQuality = R.cond([
        [R.isNil, R.always(null)],
        [R.equals(5), R.always('great')],
        [R.lte(3), R.always('good')],
        [R.gt(3), R.always('poor')],
      ]);
      try {
        // If the subscriber is no longer available, get or create a new one
        if (!subscriber.stream) {
          subscriber = await getSubscriber();
        }
        const qualityRating: QualityRating = await networkTest({ subscriber });
        ref.update({ networkQuality: networkQuality(qualityRating) });
      } catch (error) {
        console.log(error);
        ref.update({ networkQuality: null });
      }
    };
    updateNetworkQuality();
    setInterval(updateNetworkQuality, 15 * 1000);
  } catch (error) {
    console.log('Failed to set up network test', error);
    setTimeout(setupNetworkTest, 3000);
  }
};

const createActiveFanRecord: ThunkActionCreator = (uid: UserId, adminId: string, fanUrl: string): Thunk =>
  async (): AsyncVoid => {
    /* Create a record in firebase */
    const record = {
      id: uid,
    };
    const fanRef = firebase.database().ref(`activeBroadcasts/${adminId}/${fanUrl}/activeFans/${uid}`);
    try {
      // Automatically remove the active fan record on disconnect event
      fanRef.onDisconnect().remove((error: Error): void => error && console.log(error));
      fanRef.set(record);
    } catch (error) {
      console.log(error);
    }
  };

const handlePrivateCall: ThunkActionCreator = (inPrivateCall: boolean): Thunk =>
  (dispatch: Dispatch) => {
    const producerStream = opentok.getStreamByUserType('backstage', 'producer');
    const action = inPrivateCall ? 'subscribeToAudio' : 'unsubscribeFromAudio';
    opentok[action]('backstage', producerStream);
    dispatch({ type: 'SET_FAN_PRIVATE_CALL', inPrivateCall });
  };

const updateActiveFanRecord: ThunkActionCreator = (name: string, event: BroadcastEvent): Thunk =>
  async (dispatch: Dispatch): AsyncVoid => {
    const fanId = firebase.auth().currentUser.uid;
    const { adminId, fanUrl } = event;
    /* Create the snapshot and send it to the producer via firebase */
    const publisher = opentok.getPublisher('backstage');
    const record = {
      name,
      id: fanId,
      browser: platform.name,
      os: platform.os.family,
      mobile: platform.manufacturer !== null,
      snapshot: await createSnapshot(publisher),
      streamId: publisher.stream.streamId,
      isBackstage: false,
      inPrivateCall: false,
    };
    const fanRef = firebase.database().ref(`activeBroadcasts/${adminId}/${fanUrl}/activeFans/${fanId}`);
    try {
      fanRef.update(record);
      setupNetworkTest(fanId, adminId, fanUrl);
      fanRef.on('value', (snapshot: firebase.database.DataSnapshot) => {
        const { inPrivateCall, isBackstage } = snapshot.val();
        isBackstage && dispatch(setFanStatus('backstage'));
        dispatch(handlePrivateCall(inPrivateCall));
      });
    } catch (error) {
      console.log(error);
    }
  };


const joinActiveFans: ThunkActionCreator = (fanName: string): Thunk =>
  async (dispatch: Dispatch, getState: GetState): AsyncVoid => {
    const event = R.path(['broadcast', 'event'], getState());
    try {
      dispatch(updateActiveFanRecord(fanName, event));
    } catch (error) {
      console.log(error);
    }
  };

const connectToPresence: ThunkActionCreator = (uid: UserId, adminId: UserId, fanUrl: string): Thunk =>
  async (dispatch: Dispatch, getState: GetState): AsyncVoid => {
    const query = await firebase.database().ref(`activeBroadcasts/${adminId}/${fanUrl}`).once('value');
    const closedEvent = { status: 'closed' };
    const activeBroadcast = query.val() || closedEvent;
    const { activeFans, interactiveLimit } = activeBroadcast;
    const useSafari = platform.name === 'Safari';
    /* Check if the fan is able to join to the interactive broadcast. If not, the fan will see the HLS video */
    const ableToJoin = !useSafari && (!interactiveLimit || !activeFans || (activeFans && R.length(R.keys(activeFans)) < interactiveLimit));
    dispatch(setAbleToJoin(ableToJoin));
    if (ableToJoin) {
      /* Create new record to update the presence */
      dispatch(createActiveFanRecord(uid, adminId, fanUrl));
      /* Get the event data */
      const data = { adminId, fanUrl, userType: 'fan' };
      const eventData: BroadcastEvent = await getEventWithCredentials(data, R.prop('authToken', getState().auth));
      dispatch(setBroadcastEvent(eventData));
      /* Connect to interactive */
      const credentialProps = ['apiKey', 'sessionId', 'stageSessionId', 'stageToken', 'backstageToken'];
      const credentials = R.pick(credentialProps, eventData);
      dispatch(connectToInteractive(credentials, uid, adminId, fanUrl));
    } else {
      const eventData = {
        name: activeBroadcast.name,
        status: activeBroadcast.status,
        startImage: activeBroadcast.startImage,
        endImage: activeBroadcast.endImage,
        hlsUrl: activeBroadcast.hlsUrl,
      };
      dispatch(setBroadcastEvent(eventData));

      /* Let's keep the store updated in case the producer change the event status. */
      const ref = firebase.database().ref(`activeBroadcasts/${adminId}/${fanUrl}`);
      ref.on('value', (snapshot: firebase.database.DataSnapshot) => {
        /* Check if the event status and/or hlsUrl have changed */
        const updates: ActiveBroadcast = snapshot.val() || closedEvent;
        eventData.status = updates.status;
        eventData.hlsUrl = updates.hlsUrl;

        /* If the event is closing, let's give a few seconds more to the fan to finish the last part of the event */
        const hlsDelay = 15; // seconds
        const delay = updates.status === 'closed' ? hlsDelay * 1000 : 0;
        setTimeout((): void => dispatch(setBroadcastEvent(eventData)), delay);
      });
    }
  };

const initializeBroadcast: ThunkActionCreator = ({ adminId, userUrl }: FanInitOptions): Thunk =>
  async (dispatch: Dispatch): AsyncVoid => {
    try {
      // Get an Auth Token
      await dispatch(validateUser(adminId, 'fan', userUrl));

      // Connect to firebase and check the number of viewers
      firebase.auth().onAuthStateChanged(async (user: InteractiveFan): AsyncVoid => {
        if (user) {
          const query = await firebase.database().ref(`activeBroadcasts/${adminId}/${userUrl}/activeFans/${user.uid}`).once('value');
          const fanConnected = query.val();
          if (fanConnected) {
            dispatch(setBlockUserAlert());
          } else {
            dispatch(connectToPresence(user.uid, adminId, userUrl));
          }
        } else {
          await firebase.auth().signInAnonymously();
        }
      });

    } catch (error) {
      console.log('error', error);
    }
  };

const connectToBackstage: ThunkActionCreator = (fanName: string): Thunk =>
  async (dispatch: Dispatch): AsyncVoid => {
    /* Close the prompt */
    dispatch(resetAlert());
    /* Save the fan name in the storage */
    dispatch(setFanName(fanName));
    /* Connect to backstage session */
    await opentok.connect(['backstage']);
    /* Save the new backstage connection state */
    dispatch(setBackstageConnected(true));
    /* Save the fan status  */
    dispatch(setFanStatus('inLine'));
    /* update the record in firebase adding the fan name + snapshot */
    dispatch(joinActiveFans(fanName));
  };

const getInLine: ThunkActionCreator = (): Thunk =>
  (dispatch: Dispatch, getState: GetState) => {
    const fanName = R.path(['fan', 'fanName'], getState());
    const options = (): AlertPartialOptions => ({
      title: 'Almost done!',
      text: 'You may enter you name below.',
      type: 'input',
      closeOnConfirm: false,
      inputPlaceholder: 'Name (Optional)',
      allowEscapeKey: false,
      html: true,
      confirmButtonColor: '#00a3e3',
      onConfirm: (inputValue: string): void => dispatch(connectToBackstage(inputValue || 'Anonymous')),
    });
    dispatch(R.isEmpty(fanName) ? setInfo(options()) : connectToBackstage(fanName));
  };

module.exports = {
  initializeBroadcast,
  getInLine,
  leaveTheLine,
};
