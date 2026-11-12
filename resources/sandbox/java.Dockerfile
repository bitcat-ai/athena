FROM node:24-alpine
RUN apk add --no-cache git openjdk21-jdk maven
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk
