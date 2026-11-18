module Api
  module V1
    class FamiliesController < ApplicationController
      before_action :require_step_up!, except: :show
      rescue_from Families::Failure do |error|
        render json: { error: error.code }, status: :unprocessable_entity
      end

      def show
        render json: Families::Presenter.state(user: current_user)
      end

      def create
        Families::Manage.create(user: current_user)
        render json: Families::Presenter.state(user: current_user), status: :created
      end

      def invite
        Families::Manage.invite(user: current_user, email: params[:email])
        render json: Families::Presenter.state(user: current_user), status: :created
      end

      def accept
        Families::Manage.accept(user: current_user, id: params[:id])
        render json: Families::Presenter.state(user: current_user)
      end

      def remove
        Families::Manage.remove(user: current_user, id: params[:id])
        render json: Families::Presenter.state(user: current_user)
      end

      def destroy
        Families::Manage.dissolve(user: current_user)
        render json: Families::Presenter.state(user: current_user)
      end
    end
  end
end
