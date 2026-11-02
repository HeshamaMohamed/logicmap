class HealthController < ApplicationController
  def check
    if ActiveRecord::Base.connection.active?
      render json: { status: "ok" }
    else
      render json: { status: "down" }, status: :service_unavailable
    end
  end
end
