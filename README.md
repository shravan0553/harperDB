# Image Cache Resource for Walmart

This repo contains the graphql schema table declaration and resources module to enable an API cache for Walmart.

A sample call to the cache looks like: `http://localhost:9926/getImageHint/getImageHint/ip/Fallout-The-Vault-Dweller-s-Official-Cookbook-Hardcover/946465561`

## How to run locally
Harperdb 4.2 has the ability to include projects referenced from the command line.  Running the project can be done by a command like `harperdb run /home/user/code/walmart-resource-api-cache/imageCache` where the path after `run` points to the folder that holds the code for this project.

## How to install on a server
Install this project just like pre-existing Functions projects.

## The GraphQL Schema
Areas of note in the table declaration:
- `@table(table: "image_cache", expiration: 300)` 

    `table` defines the actual name of the table as your would see it in a `describe` call. 

    `expiration` defines the table level expiration (TTL) of records in seconds.
    



