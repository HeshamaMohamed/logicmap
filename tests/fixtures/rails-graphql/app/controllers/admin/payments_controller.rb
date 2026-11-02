module Admin
  class PaymentsController < Admin::ApplicationController
    before_action :load_payment, only: :destroy
    after_action :log_access, except: %i[index]

    def index
      render json: Payment.order(created_at: :desc).limit(50)
    end

    def destroy
      @payment.destroy!
      head :no_content
    end

    private

    def load_payment
      @payment = Payment.find(params[:id])
    end

    def log_access
      Rails.logger.info("admin payment #{action_name}")
    end
  end
end
