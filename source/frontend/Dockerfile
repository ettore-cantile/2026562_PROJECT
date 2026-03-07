# Use the official Nginx image as the base
FROM nginx:alpine

COPY ./html/index.html /usr/share/nginx/html/index.html
COPY ./css /usr/share/nginx/html/css/
COPY ./js /usr/share/nginx/html/js/

# Expose port 80
EXPOSE 80

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]