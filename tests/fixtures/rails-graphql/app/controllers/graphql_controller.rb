class GraphqlController < ApplicationController
  def execute
    return if reject_old_client

    result = AppSchema.execute(params[:query], context: build_context)
    render json: result
  rescue StandardError
    render json: { errors: [{ message: "Internal server error" }] }, status: :internal_server_error
  end

  private

  def reject_old_client
    version = request.headers["X-Client-Version"]
    return false if version.blank?
    return false if Gem::Version.new(version) >= Gem::Version.new("1.0.0")

    render json: { errors: [{ message: "Update the app", extensions: { code: "UPGRADE_REQUIRED" } }] }
    true
  end

  def build_context
    { current_user: User.find_by(token: request.headers["Authorization"]) }
  end
end
