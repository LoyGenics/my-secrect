module Api
  module V1
    # Session management for the signed-in user. Revoking a session
    # invalidates the server session only — it does NOT erase secrets
    # already downloaded/offline on that device (see SessionTokens).
    class SessionsController < ApplicationController
      # GET /v1/auth/sessions — live sessions, newest first. Each entry
      # carries a `current` flag for the session making this request.
      def index
        sessions = Authentication::Sessions.list(user: current_user)
        render json: { sessions: sessions.map { |s| session_json(s) } }, status: :ok
      end

      # DELETE /v1/auth/sessions/:id — revoke one session (including
      # the current one: that is a logout).
      def destroy
        session = current_user.sessions.find(params[:id])
        Authentication::Sessions.revoke(session: session, user: current_user)
        head :no_content
      end

      # DELETE /v1/auth/sessions/others — revoke every live session
      # except the current one. Step-up required. The current session
      # is never touched.
      def revoke_others
        require_step_up!
        count = Authentication::Sessions.revoke_others(user: current_user, except_session: current_session)
        render json: { revoked_count: count, current_session_id: current_session.id }, status: :ok
      end

      private

      def session_json(session)
        {
          id: session.id,
          device_id: session.device_id,
          user_agent: session.user_agent,
          ip_address: session.ip_address,
          recovery_session: session.recovery_session,
          created_at: session.created_at,
          expires_at: session.expires_at,
          current: session.id == current_session.id
        }
      end
    end
  end
end
