class ApplicationController < ActionController::API
  before_action :authenticate_request!

  rescue_from ActiveRecord::RecordNotFound, with: :render_not_found
  rescue_from ActiveRecord::RecordInvalid, with: :render_unprocessable
  rescue_from Authentication::StepUp::StepUpRequired, with: :render_step_up_required

  private

  # Bearer session token issued by AuthController after passkey verification
  # (or by the MFA/recovery completion flows). Token format (v1, opaque):
  # "sess_" + 64 hex chars; only the SHA-256 digest is stored.
  # This is ACCOUNT auth only — it never unlocks a vault.
  def authenticate_request!
    token = request.headers['Authorization']&.to_s&.sub(/\ABearer /, '')
    result = token.present? ? Authentication::SessionTokens.verify(token) : nil
    unless result
      render json: { error: 'unauthorized' }, status: :unauthorized and return
    end
    @current_user = result[:user]
    @current_device = result[:device]
    @current_session = result[:session]
    @current_raw_token = token
  end

  def current_user = @current_user
  def current_device = @current_device
  def current_session = @current_session
  # Raw Bearer token of this request (needed to rotate the session after
  # a privilege change). Never logged, never rendered except as a fresh
  # rotated token in the response that caused the rotation.
  def current_raw_token = @current_raw_token

  # Step-up: the current session must have a second-factor verification
  # within the last 10 minutes (Authentication::StepUp::WINDOW).
  # Renders 403 { error: 'step_up_required' } via the rescue above.
  def require_step_up!
    Authentication::StepUp.require!(current_session)
  end

  # Rotate the current session token after a privilege change and return
  # the fresh token (nil only if the session vanished mid-request).
  def rotate_current_session!
    Authentication::SessionTokens.rotate(current_raw_token)
  end

  def render_not_found = render json: { error: 'not_found' }, status: :not_found
  def render_unprocessable(e) = render json: { error: 'unprocessable', details: e.record.errors.full_messages }, status: :unprocessable_entity
  def render_step_up_required = render json: { error: 'step_up_required' }, status: :forbidden
end
