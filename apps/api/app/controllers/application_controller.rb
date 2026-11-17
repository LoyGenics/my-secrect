class ApplicationController < ActionController::API
  before_action :authenticate_request!

  rescue_from ActiveRecord::RecordNotFound, with: :render_not_found
  rescue_from ActiveRecord::RecordInvalid, with: :render_unprocessable

  private

  # Bearer session token issued by AuthController after passkey verification.
  # Token format (v1, opaque): "sess_<user_id>_<device_id>_<random>" stored hashed
  # in the sessions table in a full implementation; here the token is verified
  # via Authentication::SessionTokens (see app/domains/authentication).
  # This is ACCOUNT auth only — it never unlocks a vault.
  def authenticate_request!
    token = request.headers['Authorization']&.to_s&.sub(/\ABearer /, '')
    session = token.present? ? Authentication::SessionTokens.verify(token) : nil
    unless session
      render json: { error: 'unauthorized' }, status: :unauthorized and return
    end
    @current_user = session[:user]
    @current_device = session[:device]
  end

  def current_user = @current_user
  def current_device = @current_device

  def render_not_found = render json: { error: 'not_found' }, status: :not_found
  def render_unprocessable(e) = render json: { error: 'unprocessable', details: e.record.errors.full_messages }, status: :unprocessable_entity
end
