package com.acme;

public class User {
    private final String id;
    private Profile profile;

    public User(String id, Profile profile) {
        this.id = id;
        this.profile = profile;
    }

    public User(String id) {
        this.id = id;
    }

    public String id() {
        return id;
    }

    public Profile getProfile() {
        return profile;
    }
}
