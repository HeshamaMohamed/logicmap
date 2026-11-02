module Mutations
  class BaseMutation < GraphQL::Schema::RelayClassicMutation
    include SessionChecks

    def current_user
      context[:current_user]
    end
  end
end
