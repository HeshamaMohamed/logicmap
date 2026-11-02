class GraphqlController < ApplicationController
  def execute
    result = ShopSchema.execute(params[:query], variables: params[:variables], context: { current_user: current_user })
    render json: result
  end
end
