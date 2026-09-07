# Browser runtime image for `ebk browser`.
#
# Self-contained: this project does not depend on any external project. The
# base image (Selenium Standalone Chrome) already ships Chrome + WebDriver +
# Xvfb + VNC + noVNC. We layer a real XFCE desktop on top so the noVNC viewer
# shows an actual desktop you can interact with.
#
# Base image is pulled from a CN mirror for faster/offline-friendly pulls.
FROM swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/selenium/standalone-chrome:latest

USER root

# Install a lightweight desktop + terminal + handy CLI tools.
RUN apt-get update && apt-get install -y \
  xfce4 \
  xfce4-terminal \
  vim \
  curl \
  wget \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Selenium / display tuning.
ENV SE_SCREEN_WIDTH=1920
ENV SE_SCREEN_HEIGHT=1080
ENV SE_SCREEN_DEPTH=24
ENV SE_SCREEN_DPI=96
ENV SE_START_XVFB=true
ENV SE_START_VNC=true
ENV SE_START_NO_VNC=true
ENV SE_NO_VNC_PORT=7900
ENV SE_VNC_PORT=5900
ENV DISPLAY=:99.0
ENV DISPLAY_NUM=99

# Expose WebDriver, VNC and noVNC.
EXPOSE 4444
EXPOSE 5900
EXPOSE 7900

WORKDIR /home/seluser

# Run as the default Selenium user.
USER seluser

# Entry point that boots the Selenium Hub/Node + Xvfb + VNC + noVNC.
CMD ["/opt/bin/entry_point.sh"]
