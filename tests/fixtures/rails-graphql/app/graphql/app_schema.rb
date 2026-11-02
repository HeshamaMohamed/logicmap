class AppSchema < GraphQL::Schema
  EXCEPTIONS = [
    { class: SessionChecks::SignInRequired, status_code: 401, code: "UNAUTHENTICATED", message: "Sign in first" },
    { class: Pundit::NotAuthorizedError, status_code: 403, code: "FORBIDDEN", message: "Not allowed" },
    { class: ActiveRecord::RecordNotFound, status_code: 404, code: "NOT_FOUND", message: "Not found" },
    { class: StandardError, status_code: 500, code: "INTERNAL_SERVER_ERROR", message: "Unexpected error" }
  ].freeze
end
