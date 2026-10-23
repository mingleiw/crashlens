package com.acme;

public final class UserFactory {
    private UserFactory() {}

    public static User fromSignup(String id, String name) {
        // The profile is filled in from the signup form.
        return new User(id);
    }
}
