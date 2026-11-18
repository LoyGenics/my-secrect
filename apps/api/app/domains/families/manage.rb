module Families


  # Serialized on the family row for capacity and the affected user for
  # cross-family membership. No master keys, vault keys or content are involved.
  module Manage
    module_function

    def create(user:)
      user.with_lock do
        expire_invitation(user)
        raise Failure, 'already_in_family' if FamilyMembership.exists?(user: user)
        family = Family.create!(owner: user)
        family.family_memberships.create!(user: user, status: 'active', accepted_at: Time.current)
        log(user, 'family_created', family)
        family
      end
    rescue ActiveRecord::RecordNotUnique
      raise Failure, 'already_in_family'
    end

    def invite(user:, email:)
      recipient = User.find_by(email: email.to_s.strip.downcase, status: 'active')
      raise Failure, 'recipient_unavailable' unless recipient
      family = owned_family(user)
      family.with_lock do
        recipient.with_lock do
          expire_invitation(recipient)
          raise Failure, 'already_in_family' if FamilyMembership.exists?(user: recipient)
          raise Failure, 'family_full' if family.family_memberships.live.count >= Family::LIMIT
          family.family_memberships.create!(user: recipient, expires_at: 7.days.from_now)
          log(user, 'family_invited', family)
        end
      end
      family
    rescue ActiveRecord::RecordNotUnique
      raise Failure, 'already_in_family'
    end

    def accept(user:, id:)
      membership = FamilyMembership.where(user: user).find(id)
      family = membership.family
      family.with_lock do
        user.with_lock do
          membership.reload
          raise Failure, 'invitation_expired' if membership.expired?
          membership.update!(status: 'active', accepted_at: Time.current, expires_at: nil)
          log(user, 'family_joined', family)
        end
      end
      family
    end

    def remove(user:, id:)
      membership = FamilyMembership.find(id)
      family = membership.family
      # Do not reveal membership ids to outsiders.
      raise ActiveRecord::RecordNotFound unless family.owner_id == user.id || membership.user_id == user.id
      family.with_lock do
        membership.user.with_lock do
          membership.reload
          raise Failure, 'owner_cannot_leave' if membership.user_id == family.owner_id
          membership.destroy!
          log(user, 'family_member_removed', family)
        end
      end
    end

    def dissolve(user:)
      family = owned_family(user)
      family.with_lock do
        log(user, 'family_dissolved', family)
        family.destroy!
      end
    end

    def owned_family(user)
      Family.find_by!(owner: user)
    end

    def expire_invitation(user)
      FamilyMembership.where(user: user, status: 'pending').where(expires_at: ..Time.current).delete_all
    end

    def log(user, type, family)
      Audit::Log.call(user: user, event_type: type, metadata: { family_id: family.id })
    end
  end
end
