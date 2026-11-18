module Families
  module Presenter
    module_function

    def state(user:)
      current_state(user: user).merge(current_user_id: user.id)
    end

    def current_state(user:)
      membership = FamilyMembership.includes(family: :owner).find_by(user: user)
      return { family: nil, invitation: nil } unless membership && !membership.expired?
      family = membership.family
      if membership.pending?
        return { family: nil, invitation: { id: membership.id, owner_email: family.owner.email, expires_at: membership.expires_at.iso8601 } }
      end
      # Only active members can see the roster. Pending invitees see the inviter only.
      members = family.family_memberships.live.includes(:user).order(:created_at).map do |member|
        { id: member.id, user_id: member.user_id, email: member.user.email, status: member.status,
          role: member.user_id == family.owner_id ? 'owner' : 'member' }
      end
      { family: { id: family.id, owner_id: family.owner_id, role: family.owner_id == user.id ? 'owner' : 'member',
                  seats: Family::LIMIT, members: members }, invitation: nil }
    end
  end
end
