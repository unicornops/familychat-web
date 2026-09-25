/*
Copyright 2024 New Vector Ltd.
Copyright 2019-2022 The Matrix.org Foundation C.I.C.
Copyright 2026 Unicorn Operations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, type ChangeEvent, type SyntheticEvent } from "react";
import { logger } from "matrix-js-sdk/src/logger";
import { type LoginFlow, MatrixError, SSOAction, type SSOFlow } from "matrix-js-sdk/src/matrix";

import { _t } from "../../../languageHandler";
import dis from "../../../dispatcher/dispatcher";
import * as Lifecycle from "../../../Lifecycle";
import Modal from "../../../Modal";
import { type IMatrixClientCreds } from "../../../utils/createMatrixClient";
import { MatrixClientPeg } from "../../../MatrixClientPeg";
import { sendLoginRequest } from "../../../Login";
import AuthPage from "../../views/auth/AuthPage";
import { SSO_HOMESERVER_URL_KEY, SSO_ID_SERVER_URL_KEY } from "../../../BasePlatform";
import SSOButtons from "../../views/elements/SSOButtons";
import ConfirmWipeDeviceDialog from "../../views/dialogs/ConfirmWipeDeviceDialog";
import Field from "../../views/elements/Field";
import AccessibleButton from "../../views/elements/AccessibleButton";
import Spinner from "../../views/elements/Spinner";
import AuthHeader from "../../views/auth/AuthHeader";
import AuthBody from "../../views/auth/AuthBody";
import { type URLParams } from "../../../vector/url_utils.ts";
import { discardLoginLinkSession, parseLoginLinkHint, parseLoginLinkHomeserver } from "../../../utils/LoginLink";

enum LoginView {
    Loading,
    Password,
    CAS, // SSO, but old
    SSO,
    PasswordWithSocialSignOn,
    Unsupported,
}

const STATIC_FLOWS_TO_VIEWS: Record<string, LoginView> = {
    "m.login.password": LoginView.Password,
    "m.login.cas": LoginView.CAS,
    "m.login.sso": LoginView.SSO,
};

interface IProps {
    urlParams: URLParams;
    fragmentAfterLogin: string;

    // Called when the SSO login completes
    onTokenLoginCompleted: (urlParams: URLParams, fragmentAfterLogin: string) => void;
}

interface IState {
    loginView: LoginView;
    busy: boolean;
    password: string;
    errorText: string;
    flows: LoginFlow[];
}

/** Whether two homeserver base URLs point at the same server (ignoring a trailing slash or default port). */
function isSameHomeserver(a: string, b: string): boolean {
    try {
        return new URL(a).origin === new URL(b).origin;
    } catch {
        return false;
    }
}

export default class SoftLogout extends React.Component<IProps, IState> {
    public constructor(props: IProps) {
        super(props);

        this.state = {
            loginView: LoginView.Loading,
            busy: false,
            password: "",
            errorText: "",
            flows: [],
        };
    }

    public componentDidMount(): void {
        // We've ended up here when we don't need to - navigate to login
        if (!Lifecycle.isSoftLogout()) {
            dis.dispatch({ action: "start_login" });
            return;
        }

        void this.initLogin();
    }

    private onClearAll = (): void => {
        const { finished } = Modal.createDialog(ConfirmWipeDeviceDialog);
        void finished.then(([wipeData]) => {
            if (!wipeData) return;

            logger.log("Clearing data from soft-logged-out session");
            return Lifecycle.logout();
        });
    };

    private async initLogin(): Promise<void> {
        const legacySso = this.props.urlParams?.legacy_sso;
        const hasAllParams = !!legacySso?.loginToken;
        if (hasAllParams) {
            this.setState({ loginView: LoginView.Loading });

            const loggedIn = await this.trySsoLogin();
            if (loggedIn) return;
        }
        // Family Chat: a login token is single-use, so strip it (and a sign-in link's `hs`) from the URL
        // whether or not it worked, rather than leaving it in the address bar and history.
        if (legacySso) {
            this.props.onTokenLoginCompleted(this.props.urlParams, this.props.fragmentAfterLogin);
        }

        // Note: we don't use the existing Login class because it is heavily flow-based. We don't
        // care about login flows here, unless it is the single flow we support.
        const client = MatrixClientPeg.safeGet();
        const flows = (await client.loginFlows()).flows;
        const loginViews = flows.map((f) => STATIC_FLOWS_TO_VIEWS[f.type]);

        const isSocialSignOn = loginViews.includes(LoginView.Password) && loginViews.includes(LoginView.SSO);
        const firstView = loginViews.find((f) => !!f) || LoginView.Unsupported;
        const chosenView = isSocialSignOn ? LoginView.PasswordWithSocialSignOn : firstView;
        this.setState({ flows, loginView: chosenView });
    }

    private onPasswordChange = (ev: ChangeEvent<HTMLInputElement>): void => {
        this.setState({ password: ev.target.value });
    };

    private onForgotPassword = (): void => {
        dis.dispatch({ action: "start_password_recovery" });
    };

    private onPasswordLogin = async (ev: SyntheticEvent): Promise<void> => {
        ev.preventDefault();
        ev.stopPropagation();

        this.setState({ busy: true });

        const cli = MatrixClientPeg.safeGet();
        const hsUrl = cli.getHomeserverUrl();
        const isUrl = cli.getIdentityServerUrl();
        const loginType = "m.login.password";
        const loginParams = {
            identifier: {
                type: "m.id.user",
                user: cli.getUserId(),
            },
            password: this.state.password,
            device_id: cli.getDeviceId() ?? undefined,
        };

        let credentials: IMatrixClientCreds;
        try {
            credentials = await sendLoginRequest(hsUrl, isUrl, loginType, loginParams);
        } catch (e) {
            let errorText = _t("auth|failed_soft_logout_homeserver");
            if (
                e instanceof MatrixError &&
                e.errcode === "M_FORBIDDEN" &&
                (e.httpStatus === 401 || e.httpStatus === 403)
            ) {
                errorText = _t("auth|incorrect_password");
            }

            this.setState({
                busy: false,
                errorText: errorText,
            });
            return;
        }

        Lifecycle.hydrateSession(credentials).catch((e) => {
            logger.error(e);
            this.setState({ busy: false, errorText: _t("auth|failed_soft_logout_auth") });
        });
    };

    /**
     * Attempt to login via SSO
     * @returns A promise that resolves to a boolean -  true when sso login was successful
     */
    private async trySsoLogin(): Promise<boolean> {
        this.setState({ busy: true });

        const client = MatrixClientPeg.safeGet();
        const linkHs = this.props.urlParams?.legacy_sso?.hs;
        let hsUrl: string | null;
        let isUrl: string | undefined;
        if (linkHs !== undefined) {
            // Family Chat sign-in link: only redeem it against this soft-logged-out session's own homeserver, and
            // only when the link (allowlist-checked) names that same homeserver. Never use the SSO homeserver
            // remembered in local storage, which a link has nothing to do with.
            const linkHomeserver = parseLoginLinkHomeserver(linkHs);
            const expectedUserId = parseLoginLinkHint(this.props.urlParams?.legacy_sso?.login_hint);
            if (
                !linkHomeserver.ok ||
                !isSameHomeserver(linkHomeserver.url, client.getHomeserverUrl()) ||
                expectedUserId === null ||
                (expectedUserId !== undefined && expectedUserId !== client.getUserId())
            ) {
                logger.warn("Not redeeming the sign-in link: it is not for this session's homeserver and account");
                this.setState({ busy: false, errorText: _t("auth|login_link_invalid") });
                return false;
            }
            hsUrl = client.getHomeserverUrl();
            isUrl = client.getIdentityServerUrl();
        } else {
            hsUrl = localStorage.getItem(SSO_HOMESERVER_URL_KEY);
            isUrl = localStorage.getItem(SSO_ID_SERVER_URL_KEY) || client.getIdentityServerUrl();
        }
        if (!hsUrl) {
            logger.error("Homeserver URL unknown for SSO login callback");
            this.setState({ busy: false, loginView: LoginView.Unsupported });
            return false;
        }

        const loginType = "m.login.token";
        const loginParams = {
            token: this.props.urlParams?.legacy_sso?.loginToken,
            device_id: MatrixClientPeg.safeGet().getDeviceId() ?? undefined,
        };

        let credentials: IMatrixClientCreds;
        try {
            credentials = await sendLoginRequest(hsUrl, isUrl, loginType, loginParams);
        } catch (e) {
            if (linkHs !== undefined) {
                // never log the error object here: it can carry the request, and so the token
                logger.error("Failed to log in with the sign-in link's token:", (e as MatrixError)?.errcode);
                this.setState({ busy: false, errorText: _t("auth|login_link_code_rejected") });
                return false;
            }
            logger.error(e);
            this.setState({ busy: false, loginView: LoginView.Unsupported });
            return false;
        }

        if (linkHs !== undefined && credentials.userId !== client.getUserId()) {
            // A sign-in link for someone else (e.g. a sibling on the same family server). Hydrating would wipe
            // this device's session and keys, so drop the new session again and keep the soft-logged-out one.
            logger.warn("Not using the sign-in link: it is for a different account from this session's");
            await discardLoginLinkSession(hsUrl, credentials.accessToken);
            this.setState({
                busy: false,
                errorText: _t("auth|login_link_already_signed_in", { userId: client.getUserId() ?? "" }),
            });
            return false;
        }

        return Lifecycle.hydrateSession(credentials)
            .then(() => {
                this.props.onTokenLoginCompleted(this.props.urlParams, this.props.fragmentAfterLogin);
                return true;
            })
            .catch((e) => {
                logger.error(e);
                this.setState({ busy: false, loginView: LoginView.Unsupported });
                return false;
            });
    }

    private renderPasswordForm(introText?: string): JSX.Element {
        let error: JSX.Element | undefined;
        if (this.state.errorText) {
            error = <span className="mx_Login_error">{this.state.errorText}</span>;
        }

        return (
            <form onSubmit={this.onPasswordLogin}>
                {introText ? <p>{introText}</p> : null}
                {error}
                <Field
                    type="password"
                    label={_t("common|password")}
                    onChange={this.onPasswordChange}
                    value={this.state.password}
                    disabled={this.state.busy}
                />
                <AccessibleButton onClick={this.onPasswordLogin} kind="primary" disabled={this.state.busy}>
                    {_t("action|sign_in")}
                </AccessibleButton>
                <AccessibleButton onClick={this.onForgotPassword} kind="link">
                    {_t("auth|forgot_password_prompt")}
                </AccessibleButton>
            </form>
        );
    }

    private renderSsoForm(introText?: string): JSX.Element {
        const loginType = this.state.loginView === LoginView.CAS ? "cas" : "sso";
        const flow = this.state.flows.find((flow) => flow.type === "m.login." + loginType) as SSOFlow;

        return (
            <div>
                {introText ? <p>{introText}</p> : null}
                <SSOButtons
                    matrixClient={MatrixClientPeg.safeGet()}
                    flow={flow}
                    loginType={loginType}
                    fragmentAfterLogin={this.props.fragmentAfterLogin}
                    primary={!this.state.flows.find((flow) => flow.type === "m.login.password")}
                    action={SSOAction.LOGIN}
                />
            </div>
        );
    }

    private renderSignInSection(): JSX.Element {
        if (this.state.loginView === LoginView.Loading) {
            return <Spinner />;
        }

        if (this.state.loginView === LoginView.Password) {
            return this.renderPasswordForm(_t("auth|soft_logout_intro_password"));
        }

        if (this.state.loginView === LoginView.SSO || this.state.loginView === LoginView.CAS) {
            return this.renderSsoForm(_t("auth|soft_logout_intro_sso"));
        }

        if (this.state.loginView === LoginView.PasswordWithSocialSignOn) {
            // We render both forms with no intro/error to ensure the layout looks reasonably
            // okay enough.
            //
            // Note: "mx_AuthBody_centered" text taken from registration page.
            return (
                <>
                    <p>{_t("auth|soft_logout_intro_sso")}</p>
                    {this.renderSsoForm()}
                    <h2 className="mx_AuthBody_centered">
                        {_t("auth|sso_or_username_password", {
                            ssoButtons: "",
                            usernamePassword: "",
                        }).trim()}
                    </h2>
                    {this.renderPasswordForm()}
                </>
            );
        }

        // Default: assume unsupported/error
        return <p>{_t("auth|soft_logout_intro_unsupported_auth")}</p>;
    }

    public render(): React.ReactNode {
        return (
            <AuthPage>
                <AuthHeader />
                <AuthBody>
                    <h1>{_t("auth|soft_logout_heading")}</h1>

                    <h2>{_t("action|sign_in")}</h2>
                    <div>{this.renderSignInSection()}</div>

                    <h2>{_t("auth|soft_logout_subheading")}</h2>
                    <p>{_t("auth|soft_logout_warning")}</p>
                    <div>
                        <AccessibleButton onClick={this.onClearAll} kind="danger">
                            {_t("auth|soft_logout|clear_data_button")}
                        </AccessibleButton>
                    </div>
                </AuthBody>
            </AuthPage>
        );
    }
}
