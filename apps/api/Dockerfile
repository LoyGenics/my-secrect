# Build context is apps/api (see infra/docker/docker-compose.yml).
FROM ruby:3.3-slim
# libsodium23 is required at runtime by rbnacl (recovery-key signatures).
RUN apt-get update -qq && apt-get install -y build-essential libpq-dev curl libsodium23 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Gemfile Gemfile.lock* ./
RUN bundle install --without development test
COPY . ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://localhost:3000/health || exit 1
CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "3000"]
