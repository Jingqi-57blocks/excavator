Feature: AppRetirement
	Test that the app retirement feature can show the different dialogs needed for deprecated and obsolete app states

@reqTest
Scenario: Show obsolete dialog on startup when app version is obsolete and make sure it cannot be closed
	Given the apps retirement status is obsolete
	And I have launched the app
	And I have completed the onboarding flow
	And the user has completed the data transfer
	# App mode in this context is switch between onboarding, setup and daily use.
	Then the app mode change
	Then I see the App Retirement dialog
	Then I do not see the OK button
	# Tap twice to verify that the dialog cannot be closed.
	When I try to tap the Settings icon
	When I try to tap the Settings icon
	Then I am not on the Settings page
	
@reqTest
Scenario: Test supported and deprecated app retirement states
	Given I have launched the app
	And I have completed the setup
	When I tap the How To icon
	# Test supported flow that no dialog is shown.
	Given the apps retirement status is supported
	Then the app mode change
	Then I do not see the element App Retirement Dialog
	When I tap the Settings icon
	Then I am on the Settings page
	# Test deprecated flow that app retirement dialog is shown and can be closed
	Given the apps retirement status is deprecated
	Then the app mode change
	Then I see the App Retirement dialog
	When I tap the OK button
	Then I do not see the element App Retirement Dialog
	And I see the element AppVersionDeprecatedWarning
	When I tap the How To icon
	Then I am on the How To page
	# Test that the deprecated dialog can be shown twice in a row
	# if you wait for longer than the DeprecatedDismissInterval (set to 500 ms for test purpose)
	Then I wait for 1 seconds
	Then I put app into foreground
	Then I see the App Retirement dialog
	When I tap the OK button
	Then I do not see the element App Retirement Dialog
	When I tap the Settings icon
	Then I am on the Settings page
	And I see the element AppVersionDeprecatedWarning