// @flow
import R from 'ramda';
import firebase from '../services/firebase';
import { getAuthToken } from '../services/api';
import { saveAuthToken } from '../services/localStorage';
import { logIn, logOut } from './currentUser';
import { setAlert, resetAlert, setInfo } from './alert';

const authError: ActionCreator = (error: null | Error): AuthAction => ({
  type: 'AUTH_ERROR',
  error,
});

const userForgotPassword: ThunkActionCreator = (forgot: boolean): Thunk =>
  (dispatch: Dispatch) => {
    dispatch(authError(null));
    dispatch({ type: 'AUTH_FORGOT_PASSWORD', forgot });
  };

const validate: ThunkActionCreator = (uid: string): Thunk =>
  (dispatch: Dispatch) => {
    getAuthToken(uid)
      .then(({ token }: { token: string }) => {
        saveAuthToken(token);
        dispatch(logIn(uid));
      });
  };

const signIn: ThunkActionCreator = ({ email, password }: AuthCredentials): Thunk =>
  (dispatch: Dispatch) => {
    firebase.auth().signInWithEmailAndPassword(email, password)
      .then((data: Response): void => dispatch(validate(R.prop('uid', data))))
      .catch((error: Error): void => dispatch(authError(error)));
  };

const signOut: ThunkActionCreator = (): Thunk =>
  (dispatch: Dispatch) => {
    dispatch(logOut());
    firebase.auth().signOut();
  };

const resetPassword: ThunkActionCreator = ({ email }: AuthCredentials): Thunk =>
  (dispatch: Dispatch) => {
    const onSuccess = () => {
      const onConfirm: Unit = () => {
        dispatch(resetAlert());
        dispatch(userForgotPassword(false));
      };
      const options: AlertOptions = {
        show: true,
        type: 'success',
        title: 'Password Reset',
        text: 'Please check your inbox for password reset instructions',
        onConfirm,
      };
      dispatch(setAlert(options));
    };
    const onError = (): void => dispatch(setInfo('Password Reset', 'We couldn\'t find an account for that email address.'));

    firebase.auth().sendPasswordResetEmail(email)
      .then(onSuccess)
      .catch(onError);
  };

module.exports = {
  signIn,
  signOut,
  userForgotPassword,
  resetPassword,
};