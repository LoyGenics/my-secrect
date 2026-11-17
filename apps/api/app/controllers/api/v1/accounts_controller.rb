module Api
  module V1
    # DELETE /v1/auth/account — permanently delete the authenticated
    # caller. Step-up is the same check as the other sensitive account
    # routes (require_step_up!). The action ignores any user id in the
    # request and deletes only current_user.
    class AccountsController < ApplicationController
      def destroy
        require_step_up!
        Accounts::Delete.call(user: current_user)
        head :no_content
      rescue Accounts::Delete::StorageDeletionError
        render json: { error: 'storage_unavailable', message: 'object storage deletion failed; account not deleted, retry' },
               status: :service_unavailable
      end
    end
  end
end
