class Rack::Attack
  throttle("login/ip", limit: 5, period: 1.minute) do |req|
    req.ip if req.path == "/v1/login" && req.post?
  end

  throttle("api/ip", limit: 100, period: 1.minute) do |req|
    req.ip if req.path.start_with?("/graphql")
  end
end
