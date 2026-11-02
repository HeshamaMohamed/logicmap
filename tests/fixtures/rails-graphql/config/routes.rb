Rails.application.routes.draw do
  post "/graphql", to: "graphql#execute"
  get "/health", to: "health#check"
  get "up" => "rails/health#show"

  namespace :admin do
    resources :payments, only: %i[index destroy]
    get "dashboard", to: redirect(path: "/admin/payments")
  end

  if Rails.env.test?
    post "/test/reset", to: "test_helpers#reset"
  end
end
