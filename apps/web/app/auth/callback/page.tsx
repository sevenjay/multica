"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { sanitizeNextUrl, useAuthStore } from "@multica/core/auth";
import { workspaceKeys } from "@multica/core/workspace/queries";
import { paths, resolvePostAuthDestination } from "@multica/core/paths";
import { api } from "@multica/core/api";
import { createLogger } from "@multica/core/logger";
import type { User } from "@multica/core/types";
import { validateCliCallback, redirectToCliCallback } from "@multica/views/auth";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@multica/ui/components/ui/card";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "@multica/views/i18n";
import { Loader2 } from "@multica/ui/icons";
import { CliCallbackError } from "@/features/auth/cli-callback-error";
import { callbackErrorFrom, type CallbackError } from "./callback-error";

const authLogger = createLogger("auth.callback");

function CallbackContent() {
  const { t } = useT("auth");
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const loginWithGoogle = useAuthStore((s) => s.loginWithGoogle);
  const loginWithOIDC = useAuthStore((s) => s.loginWithOIDC);
  const [error, setError] = useState<CallbackError | null>(null);
  const [handoff, setHandoff] = useState<{
    token: string;
    platform: "desktop" | "mobile";
  } | null>(null);

  useEffect(() => {
    const code = searchParams.get("code");
    const state = searchParams.get("state") || "";
    const isOIDC = state.startsWith("oidc.");
    const errorParam = searchParams.get("error");
    if (errorParam) {
      authLogger.warn("OAuth returned an error parameter", errorParam);
      setError(
        errorParam === "access_denied"
          ? { kind: "access_denied" }
          : { kind: "login_failed" },
      );
      return;
    }

    if (!code) {
      setError({ kind: "missing_code" });
      return;
    }

    const redirectUri = `${window.location.origin}/auth/callback`;

    const parseAppState = (appState: string) => {
      const stateParts = appState.split(",");
      const nextPart = stateParts.find((part) => part.startsWith("next:"));
      const cliCallbackPart = stateParts.find((part) =>
        part.startsWith("cli_callback:"),
      );
      const cliStatePart = stateParts.find((part) =>
        part.startsWith("cli_state:"),
      );
      let nextRaw = nextPart?.slice("next:".length) ?? null;
      // Older Google flows sent a raw relative path. New flows encode it so
      // commas survive the comma-separated state.
      if (nextRaw && !nextRaw.startsWith("/")) {
        try {
          nextRaw = decodeURIComponent(nextRaw);
        } catch {
          nextRaw = null;
        }
      }

      try {
        const cliCallback = cliCallbackPart === undefined
          ? null
          : decodeURIComponent(cliCallbackPart.slice("cli_callback:".length));
        if (cliCallback !== null && !validateCliCallback(cliCallback)) return null;

        return {
          platform: stateParts.includes("platform:desktop")
            ? "desktop" as const
            : stateParts.includes("platform:mobile")
              ? "mobile" as const
              : null,
          nextUrl: sanitizeNextUrl(nextRaw),
          cliCallback,
          cliState: cliStatePart === undefined
            ? ""
            : decodeURIComponent(cliStatePart.slice("cli_state:".length)),
        };
      } catch {
        return null;
      }
    };

    const openNativeApp = (token: string, platform: "desktop" | "mobile") => {
      setHandoff({ token, platform });
      window.location.href = `multica://auth/callback?token=${encodeURIComponent(token)}`;
    };

    const completeWebLogin = async (loggedInUser: User, nextUrl: string | null) => {
      const wsList = await api.listWorkspaces();
      qc.setQueryData(workspaceKeys.list(), wsList);
      const onboarded = loggedInUser.onboarded_at != null;

      if (nextUrl) {
        router.push(nextUrl);
        return;
      }

      if (!onboarded) {
        try {
          const invites = await api.listMyInvitations();
          if (invites.length > 0) {
            qc.setQueryData(workspaceKeys.myInvitations(), invites);
            router.push(paths.invitations());
            return;
          }
        } catch {
          // A failed invitation lookup must not trap the user on the callback page.
        }
      }

      router.push(resolvePostAuthDestination(wsList, onboarded));
    };

    if (isOIDC) {
      loginWithOIDC(code, state)
        .then(({ user, token, appState }) => {
          const destination = parseAppState(appState);
          if (!destination) {
            setError({ kind: "invalid_cli_callback" });
            return;
          }
          if (destination.cliCallback) {
            redirectToCliCallback(
              destination.cliCallback,
              token,
              destination.cliState,
            );
            return;
          }
          if (destination.platform) {
            openNativeApp(token, destination.platform);
            return;
          }
          return completeWebLogin(user, destination.nextUrl);
        })
        .catch((err) => {
          authLogger.error("OIDC callback failed", err);
          setError(callbackErrorFrom(err));
        });
      return;
    }

    const destination = parseAppState(state);
    if (!destination) {
      setError({ kind: "invalid_cli_callback" });
      return;
    }

    const { cliCallback, cliState, platform, nextUrl } = destination;
    if (cliCallback) {
      // CLI login flow: exchange the Google code for a JWT, then redirect the
      // token back to the CLI's local HTTP listener (e.g. WSL2 host).
      api
        .googleLogin(code, redirectUri)
        .then(({ token }) => redirectToCliCallback(cliCallback, token, cliState))
        .catch((err) => {
          authLogger.error("CLI Google OAuth callback failed", err);
          setError(callbackErrorFrom(err));
        });
    } else if (platform) {
      // Native app flow: exchange code for token, then redirect via deep link.
      api
        .googleLogin(code, redirectUri)
        .then(({ token }) => openNativeApp(token, platform))
        .catch((err) => {
          authLogger.error("Native app Google OAuth callback failed", err);
          setError(callbackErrorFrom(err));
        });
    } else {
      // Normal web flow
      loginWithGoogle(code, redirectUri)
        .then((loggedInUser) => completeWebLogin(loggedInUser, nextUrl))
        .catch((err) => {
          authLogger.error("Web Google OAuth callback failed", err);
          setError(callbackErrorFrom(err));
        });
    }
  }, [searchParams, loginWithGoogle, loginWithOIDC, router, qc]);

  const errorDescription = (() => {
    if (!error) return null;
    switch (error.kind) {
      case "invalid_cli_callback":
        return null;
      case "raw":
        return error.text;
      case "missing_code":
        return t(($) => $.web.callback.missing_code);
      case "access_denied":
        return t(($) => $.web.callback.access_denied);
      case "login_failed":
        return t(($) => $.web.callback.login_failed);
      case "account_disabled":
        return t(($) => $.web.callback.account_disabled);
      case "signup_prohibited":
        return t(($) => $.web.callback.signup_prohibited);
      case "email_not_allowed":
        return t(($) => $.web.callback.email_not_allowed);
      case "google_account_no_email":
        return t(($) => $.web.callback.google_account_no_email);
      case "oauth_code_invalid":
        return t(($) => $.web.callback.oauth_code_invalid);
    }
  })();

  if (handoff) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-display-sm">
              {t(($) => handoff.platform === "mobile"
                ? $.web.mobile_handoff.opening_title
                : $.web.desktop_handoff.opening_title)}
            </CardTitle>
            <CardDescription>
              {t(($) => handoff.platform === "mobile"
                ? $.web.mobile_handoff.opening_description
                : $.web.desktop_handoff.opening_description)}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button
              variant="outline"
              onClick={() => {
                window.location.href = `multica://auth/callback?token=${encodeURIComponent(handoff.token)}`;
              }}
            >
              {t(($) => handoff.platform === "mobile"
                ? $.web.mobile_handoff.open_button
                : $.web.desktop_handoff.open_button)}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error?.kind === "invalid_cli_callback") return <CliCallbackError />;

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-display-sm">
              {t(($) => $.web.callback.failed_title)}
            </CardTitle>
            <CardDescription>
              {errorDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <a href={paths.login()} className="text-primary underline-offset-4 hover:underline">
              {t(($) => $.web.callback.back_to_login)}
            </a>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-display-sm">
            {t(($) => $.web.callback.signing_in)}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    </div>
  );
}

export default function CallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackContent />
    </Suspense>
  );
}
