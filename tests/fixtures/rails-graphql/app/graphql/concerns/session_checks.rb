module SessionChecks
  class SignInRequired < StandardError; end

  extend ActiveSupport::Concern

  included do
    if respond_to?(:argument)
      include Guards
    end
  end

  module Guards
    # Raises unless a user is signed in.
    def authenticated!
      raise SignInRequired, "Sign in first" unless context[:current_user]

      true
    end
  end
end
